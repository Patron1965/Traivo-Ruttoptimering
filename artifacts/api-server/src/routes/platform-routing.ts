import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, organizationRoutingProvidersTable, organizationsTable } from "@workspace/db";
import { GetPlatformRoutingResponse, GetPlatformOrganizationRoutingResponse,
  UpdatePlatformOrganizationRoutingBody, UpdatePlatformOrganizationRoutingResponse } from "@workspace/api-zod";
import { getRoutingConfigurationStatus, getRoutingServerForAssignment } from "../services/routing-provider-config";
import { logAdminEvent } from "../lib/security-log";
import { getPlatformServices } from "../services/platform-services";

const router: IRouter = Router();

router.get("/platform/services", (_req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  res.json(getPlatformServices());
});

router.get("/platform/routing", (_req, res): void => {
  res.setHeader("Cache-Control", "no-store");
  res.json(GetPlatformRoutingResponse.parse(getRoutingConfigurationStatus()));
});

router.get("/platform/organizations/:organizationId/routing", async (req, res): Promise<void> => {
  res.setHeader("Cache-Control", "no-store");
  const organizationId = Array.isArray(req.params.organizationId) ? req.params.organizationId[0] : req.params.organizationId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    res.status(400).json({ error: "Ogiltigt organisations-ID." });
    return;
  }
  try {
    const [organization] = await db.select({ id: organizationsTable.id }).from(organizationsTable)
      .where(eq(organizationsTable.id, organizationId)).limit(1);
    if (!organization) { res.status(404).json({ error: "Organisationen finns inte." }); return; }
    const [assignment] = await db.select({ serverId: organizationRoutingProvidersTable.serverId })
      .from(organizationRoutingProvidersTable)
      .where(eq(organizationRoutingProvidersTable.organizationId, organizationId)).limit(1);
    const serverId = assignment?.serverId ?? null;
    const effectiveId = serverId ?? "shared";
    const configuredServer = getRoutingServerForAssignment(effectiveId);
    const status = GetPlatformOrganizationRoutingResponse.parse({
      organizationId,
      serverId,
      effectiveServerId: effectiveId,
      configured: !!configuredServer,
      ...(!configuredServer ? {
        error: effectiveId === "shared"
          ? "Traivos gemensamma vägdatatjänst är inte konfigurerad"
          : "Den tilldelade routing-servern är inte längre konfigurerad.",
      } : {}),
    });
    res.json(status);
  } catch {
    res.status(500).json({ error: "Routing-inställningen kunde inte hämtas." });
  }
});

router.put("/platform/organizations/:organizationId/routing", async (req, res): Promise<void> => {
  const organizationId = Array.isArray(req.params.organizationId) ? req.params.organizationId[0] : req.params.organizationId;
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(organizationId)) {
    res.status(400).json({ error: "Ogiltigt organisations-ID." });
    return;
  }
  const parsed = UpdatePlatformOrganizationRoutingBody.safeParse(req.body);
  if (!parsed.success || !req.body || typeof req.body !== "object" || Array.isArray(req.body) ||
      Object.keys(req.body).length !== 1 || !Object.hasOwn(req.body, "serverId")) {
    res.status(400).json({ error: "Ange endast serverId som ett känt server-ID eller null." });
    return;
  }
  if (parsed.data.serverId !== null && !getRoutingServerForAssignment(parsed.data.serverId)) {
    res.status(400).json({ error: "Vald routing-server är inte konfigurerad av operatören." });
    return;
  }
  try {
    const result = await db.transaction(async (tx) => {
      const [organization] = await tx.select({ id: organizationsTable.id })
        .from(organizationsTable).where(eq(organizationsTable.id, organizationId)).limit(1).for("update");
      if (!organization) return null;
      const [old] = await tx.select({ serverId: organizationRoutingProvidersTable.serverId })
        .from(organizationRoutingProvidersTable)
        .where(eq(organizationRoutingProvidersTable.organizationId, organizationId)).limit(1);
      const serverId = parsed.data.serverId;
      if (serverId === null) {
        await tx.delete(organizationRoutingProvidersTable)
          .where(eq(organizationRoutingProvidersTable.organizationId, organizationId));
      } else {
        await tx.insert(organizationRoutingProvidersTable).values({ organizationId, serverId })
          .onConflictDoUpdate({
            target: organizationRoutingProvidersTable.organizationId,
            set: { serverId, updatedAt: new Date() },
          });
      }
      return { oldServerId: old?.serverId ?? null, serverId };
    });
    if (!result) { res.status(404).json({ error: "Organisationen finns inte." }); return; }
    await logAdminEvent({
      req,
      action: "platform.organization.routing.update",
      resourceType: "organization",
      resourceId: organizationId,
      statusCode: 200,
      diff: {
        targetOrganizationId: organizationId,
        ...(result.oldServerId === result.serverId ? {} : {
          serverId: { from: result.oldServerId, to: result.serverId },
        }),
      },
    });
    const effectiveId = result.serverId ?? "shared";
    const configuredServer = getRoutingServerForAssignment(effectiveId);
    res.json(UpdatePlatformOrganizationRoutingResponse.parse({
      organizationId,
      serverId: result.serverId,
      effectiveServerId: effectiveId,
      configured: !!configuredServer,
      ...(!configuredServer ? { error: "Traivos gemensamma vägdatatjänst är inte konfigurerad" } : {}),
    }));
  } catch {
    res.status(500).json({ error: "Routing-inställningen kunde inte sparas." });
  }
});

export default router;