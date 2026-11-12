import { Router, type IRouter } from "express";
import { and, asc, count, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { db, auditLogTable, organizationsTable, usersTable, sessionsTable, passwordResetTokensTable } from "@workspace/db";
import { notifySessionRevoked } from "../lib/session";
import {
  ListPlatformOrganizationsQueryParams, ListPlatformOrganizationsResponse,
  CreatePlatformOrganizationBody, CreatePlatformOrganizationResponse,
  UpdatePlatformOrganizationParams, UpdatePlatformOrganizationBody, UpdatePlatformOrganizationResponse,
  ListPlatformUsersParams, ListPlatformUsersResponse,
  InvitePlatformUserParams, InvitePlatformUserBody, InvitePlatformUserResponse,
  UpdatePlatformUserParams, UpdatePlatformUserBody, UpdatePlatformUserResponse,
  InitiatePlatformPasswordResetParams, InitiatePlatformPasswordResetResponse,
  GetPlatformCuoptStatusResponse, TestPlatformCuoptConnectionResponse,
  ChangePlatformOrganizationLifecycleBody,
} from "@workspace/api-zod";
import { requirePlatformAdmin } from "../middleware/auth";
import { handleError } from "../lib/errors";
import { isPasswordRecoveryConfigured, issuePasswordReset } from "../lib/password-recovery";
import { logAdminEvent, logPlatformEmailEvent } from "../lib/security-log";
import { checkRecoveryEmailDelivery, isResendId } from "../services/resend-email";
import platformUsageRouter from "./platform-usage";
import platformSupportRouter from "./platform-support";
import platformWorkspaceRouter from "./platform-workspace";
import { cuoptConfiguration, testCuoptConnection } from "../lib/cuopt-nvcf";
import { reserveLoginEmail } from "../lib/login-email";
import platformRoutingRouter from "./platform-routing";
import platformServicesRouter from "./platform-services";
import { changeOrganizationLifecycle } from "../services/organization-lifecycle";

const router: IRouter = Router();
router.use("/platform", requirePlatformAdmin());
router.use(platformSupportRouter);
router.use(platformWorkspaceRouter);
router.use(platformUsageRouter);
router.use(platformRoutingRouter);
router.use(platformServicesRouter);

// A separate platform audit view: tenant security logs remain organization-scoped.
// Expose only allowlisted metadata and never raw request bodies or credentials.
router.get("/platform/security-events", async (_req, res): Promise<void> => {
  try {
    res.setHeader("Cache-Control", "no-store");
    const rows = await db.select({
      id: auditLogTable.id, createdAt: auditLogTable.createdAt,
      action: auditLogTable.action, organizationId: auditLogTable.organizationId,
      userEmail: auditLogTable.userEmail, resourceType: auditLogTable.resourceType,
      statusCode: auditLogTable.statusCode,
      attemptId: auditLogTable.resourceId,
      providerId: sql<string | null>`CASE WHEN ${auditLogTable.action} LIKE 'platform.email_code.%' THEN ${auditLogTable.metadata}->>'providerId' ELSE NULL END`,
    }).from(auditLogTable).where(ilike(auditLogTable.action, "platform.%"))
      .orderBy(desc(auditLogTable.createdAt)).limit(100);
    res.json({ items: rows });
  } catch (error) { handleError(res, error); }
});

// Lookup only a persisted platform-code event, never an arbitrary provider message.
router.post("/platform/security-events/:id/check-delivery", async (req, res): Promise<void> => {
  try {
    res.setHeader("Cache-Control", "no-store");
    if (!isResendId(req.params.id)) { res.status(400).json({ error: "Ogiltigt händelse-id." }); return; }
    const [event] = await db.select().from(auditLogTable).where(and(
      eq(auditLogTable.id, req.params.id), eq(auditLogTable.action, "platform.email_code.accepted"),
    )).limit(1);
    const providerId = (event?.metadata as Record<string, unknown> | null)?.providerId;
    if (!event || !isResendId(providerId) || !event.resourceId) {
      res.status(404).json({ error: "Inget verifierbart utskick hittades." }); return;
    }
    const outcome = await checkRecoveryEmailDelivery(providerId);
    await logPlatformEmailEvent(event.userId, event.resourceId, {
      outcome, providerId,
    });
    res.json({ outcome });
  } catch (error) { handleError(res, error); }
});

router.get("/platform/cuopt/status", (_req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  res.json(GetPlatformCuoptStatusResponse.parse(cuoptConfiguration()));
});

router.post("/platform/cuopt/test-connection", async (_req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  res.json(TestPlatformCuoptConnectionResponse.parse(await testCuoptConnection()));
});

const orgColumns = {
  id: organizationsTable.id,
  archivedAt: organizationsTable.archivedAt,
  name: organizationsTable.name,
  email: organizationsTable.email,
  companyDetails: organizationsTable.companyDetails,
  operatingMode: organizationsTable.operatingMode,
  createdAt: organizationsTable.createdAt,
};
const userColumns = {
  id: usersTable.id,
  organizationId: usersTable.organizationId,
  name: usersTable.name,
  email: usersTable.email,
  role: usersTable.role,
  isPlatformAdmin: usersTable.isPlatformAdmin,
  isActive: usersTable.isActive,
  createdAt: usersTable.createdAt,
};

router.get("/platform/organizations", async (req, res): Promise<void> => {
  const parsed = ListPlatformOrganizationsQueryParams.safeParse(req.query);
  if (!parsed.success) { res.status(400).json({ error: "Ogiltig sökning eller sidindelning" }); return; }
  try {
    const { page, pageSize } = parsed.data;
    const search = parsed.data.search?.trim();
    const match = and(
      parsed.data.includeArchived === "true" ? undefined : isNull(organizationsTable.archivedAt),
      search ? or(ilike(organizationsTable.name, `%${search}%`), ilike(organizationsTable.email, `%${search}%`)) : undefined,
    );
    const [[total], items] = await Promise.all([
      db.select({ value: count() }).from(organizationsTable).where(match),
      db.select(orgColumns).from(organizationsTable).where(match)
        .orderBy(asc(organizationsTable.name), asc(organizationsTable.id))
        .limit(pageSize).offset((page - 1) * pageSize),
    ]);
    res.json(ListPlatformOrganizationsResponse.parse({ items, total: total.value, page, pageSize }));
  } catch (error) { handleError(res, error); }
});

router.post("/platform/organizations/:organizationId/lifecycle", async (req, res): Promise<void> => {
  const params = UpdatePlatformOrganizationParams.safeParse(req.params);
  const body = ChangePlatformOrganizationLifecycleBody.safeParse(req.body);
  if (!params.success || !body.success) { res.status(400).json({ error: "Ogiltig åtgärd eller bekräftelse." }); return; }
  try {
    await changeOrganizationLifecycle({
      organizationId: params.data.organizationId, ...body.data,
      actorId: req.user!.id,
      actorOrganizationId: req.user!.homeOrganizationId ?? req.user!.organizationId,
    });
    res.sendStatus(204);
  } catch (error) { handleError(res,error); }
});

router.post("/platform/organizations", async (req, res): Promise<void> => {
  const parsed = CreatePlatformOrganizationBody.safeParse(req.body);
  if (!parsed.success || !parsed.data.name.trim()) { res.status(400).json({ error: "Ogiltigt företagsnamn eller e-post" }); return; }
  try {
    const [org] = await db.insert(organizationsTable).values({
      name: parsed.data.name.trim(),
      companyDetails: parsed.data.companyDetails,
      brandDisplayName: parsed.data.name.trim(),
      // New customers start in shadow mode until their own notifications and
      // integrations have been configured; never inherit another customer.
      notifyOrderCreated: false,
      notifyDriverEnRoute: false,
      notifyDelivered: false,
      notifyFailed: false,
      email: parsed.data.email.trim().toLowerCase(),
      operatingMode: parsed.data.operatingMode ?? "transport",
    }).returning(orgColumns);
    await logAdminEvent({ req, action: "platform.organization.create", resourceType: "organization",
      resourceId: org.id, statusCode: 201, diff: { targetOrganizationId: org.id, name: { to: org.name } } });
    res.status(201).json(CreatePlatformOrganizationResponse.parse(org));
  } catch (error) { handleError(res, error); }
});

router.patch("/platform/organizations/:organizationId", async (req, res): Promise<void> => {
  const params = UpdatePlatformOrganizationParams.safeParse(req.params);
  const body = req.body && typeof req.body === "object" && !Array.isArray(req.body)
    ? {
        ...req.body,
        ...(typeof req.body.name === "string" ? { name: req.body.name.trim() } : {}),
        ...(typeof req.body.email === "string" ? { email: req.body.email.trim().toLowerCase() } : {}),
      }
    : req.body;
  const parsed = UpdatePlatformOrganizationBody.safeParse(body);
  const unknownFields = body && typeof body === "object" && !Array.isArray(body)
    && Object.keys(body).some((key) => !["name", "email", "operatingMode", "companyDetails"].includes(key));
  if (!params.success || !parsed.success || unknownFields || Object.keys(parsed.data).length === 0 || (parsed.data.name !== undefined && !parsed.data.name)) {
    res.status(400).json({ error: "Ange ett giltigt organisationsnamn, en giltig e-postadress och verksamhetstyp." });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [old] = await tx.select({ ...orgColumns, brandDisplayName: organizationsTable.brandDisplayName })
        .from(organizationsTable).where(eq(organizationsTable.id, params.data.organizationId)).for("update");
      if (!old) return null;
      const [updated] = await tx.update(organizationsTable).set({
        ...parsed.data,
        ...(parsed.data.name === undefined ? {} : {
          // A custom customer-facing brand remains deliberate; only the default
          // (or absent) display name follows the legal organization name.
          brandDisplayName: old.brandDisplayName === null || old.brandDisplayName === old.name
            ? parsed.data.name : old.brandDisplayName,
        }),
      }).where(eq(organizationsTable.id, old.id)).returning(orgColumns);
      return { old, updated };
    });
    if (!result) { res.status(404).json({ error: "Organisationen finns inte." }); return; }
    const { old, updated } = result;
    await logAdminEvent({ req, action: "platform.organization.update", resourceType: "organization",
      resourceId: updated.id, statusCode: 200, diff: {
        targetOrganizationId: updated.id,
        ...(JSON.stringify(old.companyDetails) === JSON.stringify(updated.companyDetails) ? {} : { companyDetails: { from: old.companyDetails, to: updated.companyDetails } }),
        ...(old.name === updated.name ? {} : { name: { from: old.name, to: updated.name } }),
        ...(old.email === updated.email ? {} : { email: { from: old.email, to: updated.email } }),
        ...(old.operatingMode === updated.operatingMode ? {} : { operatingMode: { from: old.operatingMode, to: updated.operatingMode } }),
      } });
    res.json(UpdatePlatformOrganizationResponse.parse(updated));
  } catch (error) { handleError(res, error); }
});

router.get("/platform/organizations/:organizationId/users", async (req, res): Promise<void> => {
  const params = ListPlatformUsersParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Ogiltigt företags-ID" }); return; }
  try {
    const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable)
      .where(eq(organizationsTable.id, params.data.organizationId));
    if (!org) { res.status(404).json({ error: "Företaget finns inte" }); return; }
    const users = await db.select(userColumns).from(usersTable)
      .where(eq(usersTable.organizationId, org.id)).orderBy(asc(usersTable.name), asc(usersTable.id));
    res.json(ListPlatformUsersResponse.parse(users));
  } catch (error) { handleError(res, error); }
});

router.post("/platform/organizations/:organizationId/users", async (req, res): Promise<void> => {
  const params = InvitePlatformUserParams.safeParse(req.params);
  const parsed = InvitePlatformUserBody.safeParse(req.body);
  if (!params.success || !parsed.success || !parsed.data.name.trim()) {
    res.status(400).json({ error: "Ogiltiga användaruppgifter" }); return;
  }
  if (!isPasswordRecoveryConfigured()) {
    res.status(503).json({ error: "E-postutskick för inbjudan är inte konfigurerat" }); return;
  }
  try {
    const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable)
      .where(eq(organizationsTable.id, params.data.organizationId));
    if (!org) { res.status(404).json({ error: "Företaget finns inte" }); return; }
    const email = parsed.data.email.trim().toLowerCase();
    // The login flow looks up accounts by email globally. Do not introduce
    // ambiguity across organizations (including mixed-case legacy addresses).
    const user = await db.transaction(async (tx) => {
      // Serialize platform invitations for the same login identifier.
       if (!await reserveLoginEmail(tx, email)) return null;
      const [created] = await tx.insert(usersTable).values({
        organizationId: org.id, name: parsed.data.name.trim(), email, role: parsed.data.role,
      }).returning(userColumns);
      return created;
    });
    if (!user) { res.status(409).json({ error: "E-postadressen används redan av ett konto" }); return; }
    await logAdminEvent({ req, action: "platform.user.invite", resourceType: "user",
      resourceId: user.id, statusCode: 201,
      diff: { targetOrganizationId: org.id, name: { to: user.name }, role: { to: user.role } } });
    const delivered = await issuePasswordReset(email, { userId: user.id, waitForDelivery: true, invitation: true });
    if (!delivered) {
      res.status(503).json({ error: "Kontot skapades, men inbjudan kunde inte skickas. Skicka en återställningslänk från användarlistan." });
      return;
    }
    res.status(201).json(InvitePlatformUserResponse.parse(user));
  } catch (error) { handleError(res, error); }
});

router.patch("/platform/organizations/:organizationId/users/:userId", async (req, res): Promise<void> => {
  const params = UpdatePlatformUserParams.safeParse(req.params);
  const parsed = UpdatePlatformUserBody.safeParse(req.body);
  if (!params.success || !parsed.success || !Object.keys(parsed.data).length ||
      (parsed.data.name !== undefined && !parsed.data.name.trim())) {
    res.status(400).json({ error: "Ogiltig ändring" }); return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      // Serialize administrator changes within this tenant to prevent concurrent
      // demotions from both passing the last-active-administrator check.
      await tx.select({ id: organizationsTable.id }).from(organizationsTable)
        .where(eq(organizationsTable.id, params.data.organizationId)).for("update");
      const [old] = await tx.select(userColumns).from(usersTable).where(and(
        eq(usersTable.id, params.data.userId), eq(usersTable.organizationId, params.data.organizationId),
      )).for("update");
      if (!old) return { error: "Användaren finns inte i företaget", status: 404 } as const;
      if (old.isPlatformAdmin) return { error: "Plattformskonton kan inte ändras här", status: 403 } as const;
      const email = parsed.data.email?.trim().toLowerCase() ?? old.email;
       if (email !== old.email) {
         if (!await reserveLoginEmail(tx, email, old.id))
           return { error: "E-postadressen används redan av ett konto", status: 409 } as const;
      }
      if (old.role === "admin" && old.isActive &&
          (parsed.data.role !== undefined && parsed.data.role !== "admin" || parsed.data.isActive === false)) {
        const [others] = await tx.select({ value: count() }).from(usersTable).where(sql`
          ${usersTable.organizationId} = ${old.organizationId} AND ${usersTable.id} <> ${old.id}
          AND ${usersTable.role} = 'admin' AND ${usersTable.isActive} = true AND ${usersTable.isPlatformAdmin} = false`);
        if (!others.value) return { error: "Företagets sista aktiva administratör kan inte inaktiveras eller byta roll", status: 409 } as const;
      }
      const [updated] = await tx.update(usersTable).set({
        ...parsed.data, email,
        ...(parsed.data.name === undefined ? {} : { name: parsed.data.name.trim() }),
      }).where(eq(usersTable.id, old.id)).returning(userColumns);
      const sensitive = old.email !== updated.email || old.role !== updated.role || old.isActive !== updated.isActive;
      const revoked = sensitive ? await tx.update(sessionsTable).set({ revokedAt: new Date() })
        .where(eq(sessionsTable.userId, old.id)).returning({ id: sessionsTable.id }) : [];
      if (sensitive) await tx.update(passwordResetTokensTable).set({ usedAt: new Date() }).where(eq(passwordResetTokensTable.userId, old.id));
      return { old, updated, revoked };
    });
    if (result.error !== undefined) { res.status(result.status).json({ error: result.error }); return; }
    const { old, updated, revoked } = result;
    for (const session of revoked) notifySessionRevoked(session.id);
    await logAdminEvent({ req, action: "platform.user.update", resourceType: "user", resourceId: old.id,
      statusCode: 200, diff: {
        targetOrganizationId: old.organizationId,
        ...(old.name === updated.name ? {} : { name: { from: old.name, to: updated.name } }),
        ...(old.role === updated.role ? {} : { role: { from: old.role, to: updated.role } }),
        ...(old.email === updated.email ? {} : { email: { from: old.email, to: updated.email } }),
        ...(old.isActive === updated.isActive ? {} : { isActive: { from: old.isActive, to: updated.isActive } }),
      } });
    res.json(UpdatePlatformUserResponse.parse(updated));
  } catch (error) { handleError(res, error); }
});

router.post("/platform/organizations/:organizationId/users/:userId/reset-password", async (req, res): Promise<void> => {
  const params = InitiatePlatformPasswordResetParams.safeParse(req.params);
  if (!params.success) { res.status(400).json({ error: "Ogiltigt användar-ID" }); return; }
  try {
    const [user] = await db.select(userColumns).from(usersTable).where(and(
      eq(usersTable.id, params.data.userId), eq(usersTable.organizationId, params.data.organizationId),
    ));
    if (!user) { res.status(404).json({ error: "Användaren finns inte i företaget" }); return; }
    if (user.isPlatformAdmin || !user.isActive) { res.status(403).json({ error: "Länkar kan endast skickas till aktiva kundkonton" }); return; }
    if (!isPasswordRecoveryConfigured()) {
      res.status(503).json({ error: "E-postutskick för återställning är inte konfigurerat" }); return;
    }
    const delivered = await issuePasswordReset(user.email, { userId: user.id, waitForDelivery: true });
    await logAdminEvent({ req, action: "platform.user.password_reset", resourceType: "user",
      resourceId: user.id, statusCode: delivered ? 202 : 503,
      diff: { targetOrganizationId: user.organizationId, delivery: delivered ? "sent" : "failed" } });
    if (!delivered) { res.status(503).json({ error: "Länken kunde inte skickas" }); return; }
    res.status(202).json(InitiatePlatformPasswordResetResponse.parse({ message: "Återställningslänken har skickats" }));
  } catch (error) { handleError(res, error); }
});

export default router;