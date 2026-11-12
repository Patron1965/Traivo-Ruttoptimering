import { randomBytes } from "node:crypto";
import { Router } from "express";
import { and, eq, like, sql } from "drizzle-orm";
import { db, organizationsTable, supportAccessTable } from "@workspace/db";
import { requirePlatformAdmin, isUuidParam } from "../middleware/auth";
import { hashToken } from "../lib/session";
import { workspaceHash } from "../lib/workspace-context";
import { logExportEvent } from "../lib/security-log";
import { EnterPlatformWorkspaceBody, EnterPlatformWorkspaceResponse } from "@workspace/api-zod";

const router = Router();
router.use("/platform/workspace", requirePlatformAdmin());
router.post("/platform/workspace", async (req, res, next) => {
  try {
    const parsed = EnterPlatformWorkspaceBody.safeParse(req.body);
    const organizationId = parsed.success ? parsed.data.organizationId : "";
    if (!isUuidParam(organizationId)) {
      res.status(400).json({ error: "Välj ett giltigt företag." }); return;
    }
    const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
    if (!org) { res.status(404).json({ error: "Företaget finns inte." }); return; }
    if (org.archivedAt) { res.status(409).json({ error: "Återaktivera företaget innan du öppnar arbetsmiljön." }); return; }
    const sessionToken = req.cookies?.routeai_session || req.headers.authorization?.replace(/^Bearer /, "");
    if (!sessionToken) { res.sendStatus(401); return; }
    const session = hashToken(sessionToken);
    const token = randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 60 * 60_000);
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${session}))`);
      await tx.delete(supportAccessTable).where(and(eq(supportAccessTable.session, session),
        like(supportAccessTable.tokenHash, "workspace:%")));
      await tx.insert(supportAccessTable).values({ tokenHash: workspaceHash(token), actor: req.user!.id,
        session, target: org.id, reason: "Operativ företagsåtkomst", expires });
    });
    await logExportEvent({ req, action: "platform.workspace.enter", resourceType: "organization",
      resourceId: org.id, statusCode: 201, diff: { targetOrganizationId: org.id,
        homeOrganizationId: req.user!.homeOrganizationId ?? req.user!.organizationId } });
    res.setHeader("Cache-Control", "no-store");
    res.status(201).json(EnterPlatformWorkspaceResponse.parse({ token, organizationId: org.id, organizationName: org.name, expiresAt: expires }));
  } catch (error) { next(error); }
});
router.delete("/platform/workspace", async (req, res, next) => {
  try {
    const token = req.get("X-Traivo-Workspace");
    if (!token || !req.user!.workspace) { res.status(400).json({ error: "Ingen aktiv företagsåtkomst." }); return; }
    await db.delete(supportAccessTable).where(eq(supportAccessTable.tokenHash, workspaceHash(token)));
    await logExportEvent({ req, action: "platform.workspace.exit", resourceType: "organization",
      resourceId: req.user!.organizationId, statusCode: 200, diff: { targetOrganizationId: req.user!.organizationId,
        homeOrganizationId: req.user!.homeOrganizationId } });
    res.json({ closed: true });
  } catch (error) { next(error); }
});
export default router;