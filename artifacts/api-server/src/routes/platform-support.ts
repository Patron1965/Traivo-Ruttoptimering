import { Router } from "express";
import { createHash, randomUUID } from "node:crypto";
import { eq, count, or, lte, sql, and, notLike } from "drizzle-orm";
import { db, organizationsTable, usersTable, supportAccessTable } from "@workspace/db";
import { logExportEvent } from "../lib/security-log";
import { isUuidParam } from "../middleware/auth";
import { OpenPlatformSupportAccessBody } from "@workspace/api-zod";

// Shared durable grants never authenticate normal tenant endpoints.
const digest = (token: string) => createHash("sha256").update(token).digest("hex");
const binding = (req: import("express").Request) => createHash("sha256")
  .update(req.cookies?.routeai_session || req.headers.authorization || "").digest("hex");
export function createPlatformSupportRouter() {
const router = Router();
router.use("/platform/support-access", (_req, res, next) => { res.setHeader("Cache-Control", "no-store"); next(); });

router.post("/platform/support-access", async (req, res, next) => {
  try {
    const parsed = OpenPlatformSupportAccessBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: "Ogiltigt supportärende." }); return; }
    const { organizationId, reason } = parsed.data;
    if (typeof organizationId !== "string" || !isUuidParam(organizationId) ||
        typeof reason !== "string" || reason.trim().length < 5 || reason.length > 500) {
      res.status(400).json({ error: "Ange organisation och supportärende (5–500 tecken)." }); return;
    }
    const [org] = await db.select({ id: organizationsTable.id }).from(organizationsTable).where(eq(organizationsTable.id, organizationId));
    if (!org) { res.status(404).json({ error: "Organisationen finns inte." }); return; }
    const token = randomUUID();
    const grant = { tokenHash: digest(token), actor: req.user!.id, session: binding(req), target: org.id, reason: reason.trim(), expires: new Date(Date.now() + 15 * 60_000) };
    await logExportEvent({ req, action: "platform.support.enter", resourceType: "organization", resourceId: org.id, statusCode: 201, reason: grant.reason, diff: { targetOrganizationId: org.id } });
    await db.transaction(async tx => {
      await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${grant.actor}))`);
      await tx.delete(supportAccessTable).where(or(
        and(eq(supportAccessTable.actor, grant.actor), notLike(supportAccessTable.tokenHash, "workspace:%")),
        lte(supportAccessTable.expires, new Date()),
      ));
      await tx.insert(supportAccessTable).values(grant);
    });
    res.status(201).json({ token, expiresAt: grant.expires.toISOString() });
  } catch (error) { next(error); }
});

// Token is a header, never an URL or audit-log field. Only this summary is
// accessible; no exports, arbitrary paths or operational writes are exposed.
router.all("/platform/support-access/current", async (req, res, next) => {
  try {
    const token = req.get("X-Support-Access") ?? "";
    const tokenHash = digest(token);
    const [grant] = await db.select().from(supportAccessTable).where(eq(supportAccessTable.tokenHash, tokenHash));
    if (!grant || grant.actor !== req.user!.id || grant.session !== binding(req) || grant.expires.getTime() <= Date.now()) {
      res.status(403).json({ error: "Supportåtkomsten har upphört. Öppna ett nytt supportärende." }); return;
    }
    if (req.method !== "GET" && req.method !== "DELETE") {
      res.status(403).json({ error: "Supportläget är endast läsbehörigt." }); return;
    }
    await logExportEvent({ req, action: req.method === "DELETE" ? "platform.support.exit" : "platform.support.read", resourceType: "organization", resourceId: grant.target, statusCode: 200, reason: grant.reason, diff: { targetOrganizationId: grant.target } });
    if (req.method === "DELETE") { await db.delete(supportAccessTable).where(eq(supportAccessTable.tokenHash, tokenHash)); res.json({ closed: true }); return; }
    const [organization] = await db.select({ id: organizationsTable.id, name: organizationsTable.name, operatingMode: organizationsTable.operatingMode }).from(organizationsTable).where(eq(organizationsTable.id, grant.target));
    if (!organization) { res.status(404).json({ error: "Organisationen finns inte." }); return; }
    const [total] = await db.select({ value: count() }).from(usersTable).where(eq(usersTable.organizationId, grant.target));
    res.json({ organization, userCount: total.value, reason: grant.reason, expiresAt: grant.expires.toISOString(), readOnly: true });
  } catch (error) { next(error); }
});
return router;
}
export default createPlatformSupportRouter();