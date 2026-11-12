import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, usersTable, userGroupsTable, sessionsTable, passwordResetTokensTable, driversTable, vehiclesTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { getOrgId, requireRole } from "../middleware/auth";
import { hashPassword } from "../lib/password";
import { logAdminEvent } from "../lib/security-log";
import { duplicateLoginEmailError, normalizeLoginEmail, reserveLoginEmail } from "../lib/login-email";
import { notifySessionRevoked } from "../lib/session";

const router: IRouter = Router();
async function resolveResourceProfile(
  tx: Parameters<Parameters<typeof db.transaction>[0]>[0],
  organizationId: string,
  resourceId: unknown,
): Promise<string | null> {
  if (resourceId === null) return null;
  if (typeof resourceId !== "string" || !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(resourceId)) {
    throw Object.assign(new Error("resourceId must be a UUID or null"), { status: 400 });
  }
  const [resource] = await tx.select({ id: vehiclesTable.id }).from(vehiclesTable).where(and(
    eq(vehiclesTable.id, resourceId), eq(vehiclesTable.organizationId, organizationId), eq(vehiclesTable.isActive, true),
  )).for("update");
  if (!resource) throw Object.assign(new Error("Resource not found in this organization"), { status: 404 });
  const profiles = await tx.select({ id: driversTable.id }).from(driversTable).where(and(
    eq(driversTable.vehicleId, resourceId), eq(driversTable.organizationId, organizationId), eq(driversTable.isActive, true),
  )).for("update");
  if (profiles.length !== 1) throw Object.assign(new Error("Resource profile needs review"), { status: 409 });
  return profiles[0].id;
}
function safeUser(user: typeof usersTable.$inferSelect) {
  const { passwordHash: _passwordHash, mfaRecoveryRequired: _mfaRecoveryRequired, mfaSecret: _mfaSecret, mfaPendingSecret: _mfaPendingSecret,
    mfaPendingSessionId: _mfaPendingSessionId, mfaLastStep: _mfaLastStep, mfaRecoveryHashes: _mfaRecoveryHashes,
    mfaFailedAttempts: _mfaFailedAttempts, mfaFailureWindowStartedAt: _mfaFailureWindowStartedAt,
    mfaLockedUntil: _mfaLockedUntil, ...safe } = user;
  return safe;
}

// Tenant administrators must never modify or delete a platform administrator
// from the ordinary user screen (including password and driver-link changes).
router.use("/app-users/:id", async (req, res, next) => {
  if (!["PUT", "PATCH", "POST", "DELETE"].includes(req.method) || req.user?.isPlatformAdmin) {
    next();
    return;
  }
  const id = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
  if (!id || !/^[0-9a-f-]{36}$/i.test(id)) { next(); return; }
  try {
    const [target] = await db.select({ isPlatformAdmin: usersTable.isPlatformAdmin })
      .from(usersTable).where(and(eq(usersTable.id, id), eq(usersTable.organizationId, req.user!.organizationId)));
    if (target?.isPlatformAdmin) {
      res.status(403).json({ error: "Forbidden: platform administrator account" });
      return;
    }
    next();
  } catch (error) { next(error); }
});

function driverLinkErrorStatus(err: unknown): number | undefined {
  let candidate: { status?: unknown; code?: unknown; cause?: unknown } | undefined =
    err && typeof err === "object" ? err as { status?: unknown; code?: unknown; cause?: unknown } : undefined;
  for (let depth = 0; candidate && depth < 3; depth += 1) {
    if (typeof candidate.status === "number") return candidate.status;
    // The partial unique index is the final race-safe guard when two admins
    // attempt to claim the same profile concurrently. Drizzle wraps driver
    // errors, so inspect the nested cause as well.
    if (candidate.code === "23505") return 409;
    candidate = candidate.cause && typeof candidate.cause === "object"
      ? candidate.cause as { status?: unknown; code?: unknown; cause?: unknown }
      : undefined;
  }
  return undefined;
}

router.get("/app-users", requireRole("admin"), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const users = await db.select({
      id: usersTable.id,
      organizationId: usersTable.organizationId,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      groupId: usersTable.groupId,
      driverProfileId: usersTable.driverProfileId,
      createdAt: usersTable.createdAt,
      groupName: userGroupsTable.name,
      driverName: driversTable.name,
      driverIsActive: driversTable.isActive,
      resourceId: vehiclesTable.id,
      resourceName: vehiclesTable.name,
    }).from(usersTable)
      .leftJoin(userGroupsTable, eq(usersTable.groupId, userGroupsTable.id))
      .leftJoin(driversTable, and(
        eq(usersTable.driverProfileId, driversTable.id),
        eq(driversTable.organizationId, orgId),
      ))
      .leftJoin(vehiclesTable, and(eq(vehiclesTable.id, driversTable.vehicleId), eq(vehiclesTable.organizationId, orgId)))
      .where(eq(usersTable.organizationId, orgId));
    res.json(users);
  } catch (err) { handleError(res, err); }
});

router.post("/app-users", requireRole("admin"), async (req, res) => {
  try {
    const orgId = req.user!.organizationId;
    const { name, email, role, groupId, password, driverProfileId: legacyDriverProfileId, resourceId } = req.body;
    const driverProfileId = legacyDriverProfileId;
    if (!name || typeof email !== "string" || !email.trim() || !orgId) { res.status(400).json({ error: "name, email, and organizationId required" }); return; }
    if (driverProfileId !== undefined && driverProfileId !== null && typeof driverProfileId !== "string") {
      res.status(400).json({ error: "driverProfileId must be a UUID or null" });
      return;
    }
    const passwordHash = typeof password === "string" && password.length > 0
      ? await hashPassword(password)
      : null;
    const user = await db.transaction(async (tx) => {
      const driverProfileId = resourceId !== undefined
        ? await resolveResourceProfile(tx, orgId, resourceId) : legacyDriverProfileId;
      if (!await reserveLoginEmail(tx, email)) throw duplicateLoginEmailError();
      if (driverProfileId) {
        const [driver] = await tx.select({ id: driversTable.id })
          .from(driversTable)
          .where(and(eq(driversTable.id, driverProfileId), eq(driversTable.organizationId, orgId)));
        if (!driver) {
          const error = new Error("Driver profile not found in this organization");
          (error as Error & { status?: number }).status = 404;
          throw error;
        }
        const [linked] = await tx.select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.driverProfileId, driverProfileId))
          .limit(1);
        if (linked) {
          const error = new Error("Driver profile is already linked to an account");
          (error as Error & { status?: number }).status = 409;
          throw error;
        }
      }
      const [created] = await tx.insert(usersTable).values({
        name,
        email: normalizeLoginEmail(email),
        role: role || (driverProfileId ? "driver" : "dispatcher"),
        groupId,
        organizationId: orgId,
        passwordHash,
        driverProfileId: driverProfileId ?? null,
      }).returning();
      return created;
    });
    await logAdminEvent({
      req,
      action: "user.create",
      resourceType: "user",
      resourceId: user.id,
      statusCode: 201,
      diff: { name: { to: user.name }, email: { to: user.email }, role: { to: user.role } },
    });
    res.status(201).json(safeUser(user));
  } catch (err) {
    if (err instanceof Error && "statusCode" in err) { handleError(res, err); return; }
    const status = driverLinkErrorStatus(err);
    if (status) {
      res.status(status).json({
        error: status === 409 ? "Driver profile is already linked to an account" : (err as Error).message,
      });
      return;
    }
    handleError(res, err);
  }
});

router.put("/app-users/:id", requireRole("admin"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const [existing] = await db.select().from(usersTable)
      .where(and(eq(usersTable.id, id), eq(usersTable.organizationId, orgId)));
    if (!existing) { res.status(404).json({ error: "User not found" }); return; }

    const updates: Record<string, unknown> = {};
    const diff: Record<string, unknown> = {};
    if (req.body.name !== undefined && req.body.name !== existing.name) {
      updates.name = req.body.name; diff.name = { from: existing.name, to: req.body.name };
    }
    if (req.body.email !== undefined) {
      if (typeof req.body.email !== "string" || !req.body.email.trim()) {
        res.status(400).json({ error: "Invalid email" }); return;
      }
      const normalizedEmail = normalizeLoginEmail(req.body.email);
      if (normalizedEmail !== existing.email) {
        updates.email = normalizedEmail; diff.email = { from: existing.email, to: normalizedEmail };
      }
    }
    if (req.body.role !== undefined && req.body.role !== existing.role) {
      updates.role = req.body.role; diff.role = { from: existing.role, to: req.body.role };
    }
    if (req.body.groupId !== undefined && req.body.groupId !== existing.groupId) {
      updates.groupId = req.body.groupId; diff.groupId = { from: existing.groupId, to: req.body.groupId };
    }
    const hasDriverLinkChange =
      Object.prototype.hasOwnProperty.call(req.body, "driverProfileId") &&
      req.body.driverProfileId !== existing.driverProfileId;
    if (hasDriverLinkChange) {
      const driverProfileId = req.body.driverProfileId;
      if (driverProfileId !== null && typeof driverProfileId !== "string") {
        res.status(400).json({ error: "driverProfileId must be a UUID or null" });
        return;
      }
      updates.driverProfileId = driverProfileId ?? null;
      diff.driverProfileId = { from: existing.driverProfileId, to: driverProfileId ?? null };
    }
    if (typeof req.body.password === "string" && req.body.password.length > 0) {
      updates.passwordHash = await hashPassword(req.body.password);
      diff.password = { changed: true };
    }

    if (Object.keys(updates).length === 0 && req.body.resourceId === undefined) {
      res.json(safeUser(existing));
      return;
    }

    const result = await db.transaction(async (tx) => {
        if (req.body.resourceId !== undefined) {
          updates.driverProfileId = await resolveResourceProfile(tx, orgId, req.body.resourceId);
          diff.driverProfileId = { from: existing.driverProfileId, to: updates.driverProfileId };
        }
        if (updates.email && !await reserveLoginEmail(tx, updates.email as string, id))
          throw duplicateLoginEmailError();
        const driverProfileId = updates.driverProfileId as string | null;
        if ((hasDriverLinkChange || req.body.resourceId !== undefined) && driverProfileId) {
          const [driver] = await tx.select({ id: driversTable.id })
            .from(driversTable)
            .where(and(eq(driversTable.id, driverProfileId), eq(driversTable.organizationId, orgId)));
          if (!driver) {
            const error = new Error("Driver profile not found in this organization");
            (error as Error & { status?: number }).status = 404;
            throw error;
          }
          const [otherLink] = await tx.select({ id: usersTable.id })
            .from(usersTable)
            .where(eq(usersTable.driverProfileId, driverProfileId))
            .limit(1);
          if (otherLink && otherLink.id !== id) {
            const error = new Error("Driver profile is already linked to another account");
            (error as Error & { status?: number }).status = 409;
            throw error;
          }
        }
        const [updated] = await tx.update(usersTable).set(updates as any)
          .where(and(eq(usersTable.id, id), eq(usersTable.organizationId, orgId))).returning();
        const sensitive = Boolean(updates.email || updates.passwordHash || updates.role ||
          (updates.driverProfileId !== undefined && updates.driverProfileId !== existing.driverProfileId));
        const revoked = sensitive ? await tx.update(sessionsTable).set({ revokedAt: new Date() })
          .where(eq(sessionsTable.userId, id)).returning({ id: sessionsTable.id }) : [];
        if (sensitive) await tx.update(passwordResetTokensTable).set({ usedAt: new Date() })
          .where(eq(passwordResetTokensTable.userId, id));
        return { updated, revoked };
      });
    const user = result.updated;
    for (const session of result.revoked) notifySessionRevoked(session.id);
    await logAdminEvent({
      req,
      action: diff.role ? "user.role_change" : "user.update",
      resourceType: "user",
      resourceId: id,
      statusCode: 200,
      diff,
    });
    res.json(safeUser(user));
  } catch (err) {
    if (err instanceof Error && "statusCode" in err) { handleError(res, err); return; }
    const status = driverLinkErrorStatus(err);
    if (status) {
      res.status(status).json({
        error: status === 409 ? "Driver profile is already linked to an account" : (err as Error).message,
      });
      return;
    }
    handleError(res, err);
  }
});

/**
 * Link or unlink an existing driver profile without deleting or mutating the
 * driver record. Route and execution history therefore remain intact.
 */
router.post("/app-users/:id/driver-link", requireRole("admin"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const driverProfileId = req.body?.driverProfileId ?? null;
    if (driverProfileId !== null && typeof driverProfileId !== "string") {
      res.status(400).json({ error: "driverProfileId must be a UUID or null" });
      return;
    }

    const user = await db.transaction(async (tx) => {
      const [existing] = await tx.select({ id: usersTable.id })
        .from(usersTable)
        .where(and(eq(usersTable.id, id), eq(usersTable.organizationId, orgId)));
      if (!existing) {
        const error = new Error("User not found");
        (error as Error & { status?: number }).status = 404;
        throw error;
      }

      if (driverProfileId) {
        const [driver] = await tx.select({ id: driversTable.id })
          .from(driversTable)
          .where(and(eq(driversTable.id, driverProfileId), eq(driversTable.organizationId, orgId)));
        if (!driver) {
          const error = new Error("Driver profile not found in this organization");
          (error as Error & { status?: number }).status = 404;
          throw error;
        }
        const [linked] = await tx.select({ id: usersTable.id })
          .from(usersTable)
          .where(eq(usersTable.driverProfileId, driverProfileId))
          .limit(1);
        if (linked && linked.id !== id) {
          const error = new Error("Driver profile is already linked to another account");
          (error as Error & { status?: number }).status = 409;
          throw error;
        }
      }

      const [updated] = await tx.update(usersTable)
        .set({ driverProfileId })
        .where(and(eq(usersTable.id, id), eq(usersTable.organizationId, orgId)))
        .returning();
      return updated;
    });

    await logAdminEvent({
      req,
      action: driverProfileId ? "user.driver_link" : "user.driver_unlink",
      resourceType: "user",
      resourceId: id,
      statusCode: 200,
      diff: { driverProfileId: { to: driverProfileId } },
    });
    res.json(safeUser(user));
  } catch (err) {
    const status = driverLinkErrorStatus(err);
    if (status) {
      res.status(status).json({
        error: status === 409 ? "Driver profile is already linked to an account" : (err as Error).message,
      });
      return;
    }
    handleError(res, err);
  }
});

router.delete("/app-users/:id/driver-link", requireRole("admin"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const [user] = await db.update(usersTable)
      .set({ driverProfileId: null })
      .where(and(eq(usersTable.id, id), eq(usersTable.organizationId, orgId)))
      .returning();
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    await logAdminEvent({
      req,
      action: "user.driver_unlink",
      resourceType: "user",
      resourceId: id,
      statusCode: 200,
      diff: { driverProfileId: { from: user.driverProfileId, to: null } },
    });
    res.json(safeUser(user));
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/app-users/:id", requireRole("admin"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    if (id === req.user!.id) { res.status(400).json({ error: "You cannot delete your own account" }); return; }
    const deleted = await db.transaction(async (tx) => {
      const [existing] = await tx.select().from(usersTable)
        .where(and(eq(usersTable.id, id), eq(usersTable.organizationId, orgId)));
      if (!existing) return null;

      await tx.delete(sessionsTable).where(eq(sessionsTable.userId, id));
      const [removed] = await tx.delete(usersTable)
        .where(and(eq(usersTable.id, id), eq(usersTable.organizationId, orgId)))
        .returning();
      return removed ?? null;
    });
    if (!deleted) { res.status(404).json({ error: "User not found" }); return; }
    await logAdminEvent({
      req,
      action: "user.delete",
      resourceType: "user",
      resourceId: id,
      statusCode: 204,
      diff: { name: { from: deleted.name }, email: { from: deleted.email }, role: { from: deleted.role } },
    });
    res.status(204).send();
  } catch (err) { handleError(res, err); }
});

export default router;
