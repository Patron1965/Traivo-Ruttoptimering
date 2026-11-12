import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { z } from "zod";
import { db, portalAccountsTable as accounts, portalTokensTable as tokens, portalContactsTable as contacts,
  customersTable, stopsTable, vehiclesTable, type PortalAccount } from "@workspace/db";
import { CreatePortalAccountBody, UpdatePortalAccountBody, UpdatePortalContactBody } from "@workspace/api-zod";
import { getOrgId, requireRole } from "../middleware/auth";
import { privateLinkHeaders } from "./public-tracking";
import { invitePortal, portalEmail, type PortalMail } from "../services/portal-auth";
import rateLimit from "express-rate-limit";

const publicAccount = (row: PortalAccount) => ({ id: row.id, name: row.name, email: row.email,
  enabled: row.enabled, customerIds: row.customerIds, stopIds: row.stopIds, activated: Boolean(row.passwordHash) });
const fail = (message: string, statusCode = 400) => { throw Object.assign(new Error(message), { statusCode }); };
export function createPortalAdminRouter(mail?: PortalMail): IRouter {
  const router = Router();
  router.use("/portal-admin", privateLinkHeaders, requireRole("admin"));
  router.get("/portal-admin/accounts", async (req, res) => {
    const rows = await db.select().from(accounts).where(eq(accounts.organizationId, getOrgId(req)));
    res.json(rows.map(publicAccount));
  });
  async function save(organizationId: string, raw: unknown, id?: string) {
    const input = (id ? UpdatePortalAccountBody : CreatePortalAccountBody).parse(raw);
    if (!input.name.trim()) fail("Ange kundkontots namn.");
    if (input.enabled && !input.customerIds.length && !input.stopIds.length) fail("Välj minst en kundpost eller order.");
    return db.transaction(async tx => {
      const [current] = id ? await tx.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.organizationId, organizationId))).for("update") : [];
      if (id && !current) fail("Kundkontot finns inte.", 404);
      const customerIds = [...new Set(input.customerIds)], stopIds = [...new Set(input.stopIds)];
      const customers = customerIds.length ? await tx.select({ id: customersTable.id }).from(customersTable)
        .where(and(eq(customersTable.organizationId, organizationId), inArray(customersTable.id, customerIds))) : [];
      const stops = stopIds.length ? await tx.select({ id: stopsTable.id }).from(stopsTable)
        .where(and(eq(stopsTable.organizationId, organizationId), inArray(stopsTable.id, stopIds))) : [];
      if (customers.length !== customerIds.length || stops.length !== stopIds.length) fail("Urvalet innehåller kundposter eller order som inte är tillgängliga.");
      const values = { name: input.name.trim(), email: portalEmail(input.email), enabled: input.enabled, customerIds, stopIds };
      if (current) {
        // Editing identity/scope never silently transfers a live authenticated session.
        await tx.delete(tokens).where(eq(tokens.accountId, current.id));
        const [updated] = await tx.update(accounts).set({ ...values,
          ...(values.email !== current.email ? { passwordHash: null, failedAttempts: 0, lockedUntil: null } : {}) })
          .where(eq(accounts.id, current.id)).returning();
        return publicAccount(updated);
      }
      const [created] = await tx.insert(accounts).values({ organizationId, ...values }).returning();
      return publicAccount(created);
    });
  }
  router.post("/portal-admin/accounts", async (req, res) => {
    res.status(201).json(await save(getOrgId(req), req.body));
  });
  router.put("/portal-admin/accounts/:id", async (req, res) => {
    const id = z.guid().parse(req.params.id);
    res.json(await save(getOrgId(req), req.body, id));
  });
  router.post("/portal-admin/accounts/:id/invite", rateLimit({
    windowMs: 15 * 60_000, limit: 15, standardHeaders: true, legacyHeaders: false, validate: false,
  }), async (req, res) => {
    const id = z.guid().parse(req.params.id);
    const [account] = await db.select().from(accounts).where(and(eq(accounts.id, id), eq(accounts.organizationId, getOrgId(req)), eq(accounts.enabled, true)));
    if (!account) { res.status(404).json({ error: "Kundkontot är inte tillgängligt." }); return; }
    if (!await invitePortal(id, getOrgId(req), mail)) { res.status(503).json({ error: "Inbjudan kunde inte skickas. Kontrollera e-postinställningarna och försök igen." }); return; }
    res.status(204).send();
  });
  router.get("/portal-admin/contacts", async (req, res) => {
    const rows = await db.select().from(contacts).where(eq(contacts.organizationId, getOrgId(req)));
    res.json(rows.map(({ vehicleId, name, phone, enabled }) => ({ vehicleId, name, phone, enabled })));
  });
  router.put("/portal-admin/contacts/:vehicleId", async (req, res) => {
    const vehicleId = z.guid().parse(req.params.vehicleId);
    const body = UpdatePortalContactBody.parse(req.body), organizationId = getOrgId(req);
    const name = body.name.trim(), phone = body.phone.trim();
    if (body.enabled && (!name || !/^\+?[0-9][0-9 ()-]{3,38}[0-9]$/.test(phone))) fail("Ange ett namn och ett giltigt arbetsnummer.");
    const [vehicle] = await db.select({ id: vehiclesTable.id }).from(vehiclesTable)
      .where(and(eq(vehiclesTable.id, vehicleId), eq(vehiclesTable.organizationId, organizationId)));
    if (!vehicle) { res.status(404).json({ error: "Resursen finns inte." }); return; }
    await db.insert(contacts).values({ organizationId, vehicleId, name, phone, enabled: body.enabled })
      .onConflictDoUpdate({ target: contacts.vehicleId, set: { name, phone, enabled: body.enabled },
        setWhere: eq(contacts.organizationId, organizationId) });
    res.json({ vehicleId, name, phone, enabled: body.enabled });
  });
  router.use((err: unknown, _req: import("express").Request, res: import("express").Response, _next: import("express").NextFunction) => {
    if (err instanceof z.ZodError) { res.status(400).json({ error: "Kontrollera de ifyllda uppgifterna." }); return; }
    const e = err as { code?: string; cause?: { code?: string }; statusCode?: number; message?: string };
    if (e.code === "23505" || e.cause?.code === "23505") { res.status(409).json({ error: "E-postadressen kan inte användas för ett nytt kundkonto." }); return; }
    res.status(e.statusCode ?? 503).json({ error: e.statusCode ? e.message : "Ändringen kunde inte sparas. Försök igen." });
  });
  return router;
}
export default createPortalAdminRouter();
