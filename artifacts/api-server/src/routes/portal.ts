import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { and, eq } from "drizzle-orm";
import { db, portalAccountsTable, portalTokensTable } from "@workspace/db";
import { PortalAccessBody, PortalLoginBody, PortalRecoverBody, PortalResetBody, GetPortalOrdersResponse, GetPortalOrderResponse, GetPortalOrdersQueryParams } from "@workspace/api-zod";
import { z } from "zod";
import { privateLinkHeaders } from "./public-tracking";
import { portalOrigin, portalSession, portalEmail, portalTokenHash, loginPortal, invitePortal, redeemPortalAccess, resetPortalPassword, PORTAL_SESSION_MS, type PortalMail } from "../services/portal-auth";
import { listPortalOrders, portalOrderDetail } from "../services/portal-orders";
import { parsePortalCursor } from "../services/portal-order-history";
import { type RoadAdapter } from "../services/customer-live-tracking";

export const PORTAL_COOKIE = "traivo_customer_session";
export function createPortalRouter(options: { mail?: PortalMail; road?: RoadAdapter } = {}): IRouter {
  const router = Router();
  router.use(privateLinkHeaders);
  router.use(rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: true, legacyHeaders: false, validate: false }));
  router.use((req, res, next) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      const origin = req.get("origin");
      const trusted = portalOrigin();
      if (req.get("sec-fetch-site") === "cross-site" || (origin && (!trusted || origin !== new URL(trusted).origin))) {
        res.status(403).json({ error: "Begäran kommer från fel webbplats." }); return;
      }
    }
    next();
  });
  const authLimit = rateLimit({ windowMs: 15 * 60_000, limit: 15, standardHeaders: true, legacyHeaders: false, validate: false });
  router.post("/access", authLimit, async (req, res) => {
    const body = PortalAccessBody.safeParse(req.body);
    const result = body.success ? await redeemPortalAccess(body.data.token) : null;
    if (!result) { res.status(401).json({ error: "Länken är ogiltig, använd eller har gått ut. Begär en ny länk." }); return; }
    res.cookie(PORTAL_COOKIE, result.token, { httpOnly: true, sameSite: "strict",
      secure: process.env.NODE_ENV === "production", maxAge: PORTAL_SESSION_MS, path: "/" });
    res.json(result.identity);
  });
  router.post("/login", authLimit, async (req, res) => {
    const body = PortalLoginBody.safeParse(req.body);
    if (!body.success) { res.status(400).json({ error: "Kontrollera e-post och lösenord." }); return; }
    const result = await loginPortal(body.data.email, body.data.password);
    if (!result) { res.status(401).json({ error: "Inloggningen misslyckades. Kontrollera uppgifterna eller försök senare." }); return; }
    res.cookie(PORTAL_COOKIE, result.token, { httpOnly: true, sameSite: "strict",
      secure: process.env.NODE_ENV === "production", maxAge: PORTAL_SESSION_MS, path: "/" });
    res.json(result.identity);
  });
  router.post("/logout", async (req, res) => {
    const token = req.cookies?.[PORTAL_COOKIE];
    if (typeof token === "string") await db.delete(portalTokensTable).where(and(
      eq(portalTokensTable.hash, portalTokenHash(token)), eq(portalTokensTable.purpose, "session")));
    res.clearCookie(PORTAL_COOKIE, { path: "/" });
    res.status(204).send();
  });
  router.post("/recover", authLimit, async (req, res) => {
    const body = PortalRecoverBody.safeParse(req.body);
    if (body.success) {
      const [account] = await db.select().from(portalAccountsTable).where(eq(portalAccountsTable.email, portalEmail(body.data.email)));
      // Same response and no provider wait, whether or not an account exists.
      if (account?.enabled) void invitePortal(account.id, null, options.mail).catch(() => {});
    }
    res.status(202).send();
  });
  router.post("/reset", authLimit, async (req, res) => {
    const body = PortalResetBody.safeParse(req.body);
    if (!body.success || !await resetPortalPassword(body.data.token, body.data.password)) {
      res.status(400).json({ error: "Länken är ogiltig eller har gått ut. Begär en ny länk. Lösenordet måste ha minst 12 tecken." }); return;
    }
    res.clearCookie(PORTAL_COOKIE, { path: "/" }); res.status(204).send();
  });
  router.use(async (req, res, next) => {
    const account = await portalSession(req.cookies?.[PORTAL_COOKIE]);
    if (!account) { res.status(401).json({ error: "Logga in i kundportalen igen." }); return; }
    res.locals.portalAccount = account; next();
  });
  router.get("/me", (_req, res) => { const { id, name } = res.locals.portalAccount; res.json({ id, name }); });
  router.get(["/orders", "/orders/active"], async (req, res) => {
    const parsed = GetPortalOrdersQueryParams.safeParse(req.query);
    const validDay = (value: string | undefined) => !value || (/^\d{4}-\d{2}-\d{2}$/.test(value)
      && Number.isFinite(Date.parse(value)) && new Date(value).toISOString().slice(0, 10) === value);
    if (!parsed.success || !validDay(parsed.data.from) || !validDay(parsed.data.to)
      || (parsed.data.from && parsed.data.to && parsed.data.from > parsed.data.to)
      || (parsed.data.asOf && !z.string().datetime({ offset: true }).safeParse(parsed.data.asOf).success)) {
      res.status(400).json({ error: "Kontrollera datum och sökfilter." }); return;
    }
    try { parsePortalCursor(parsed.data.cursor); } catch {
      res.status(400).json({ error: "Ogiltig sida. Läs in orderhistoriken igen." }); return;
    }
    const result = await listPortalOrders(res.locals.portalAccount, parsed.data, req.path === "/orders/active");
    if (!await portalSession(req.cookies?.[PORTAL_COOKIE])) { res.status(401).json({ error: "Åtkomsten har upphört." }); return; }
    res.json(GetPortalOrdersResponse.parse(result));
  });
  router.get("/orders/:id", async (req, res) => {
    if (!z.guid().safeParse(req.params.id).success) { res.status(404).json({ error: "Ordern finns inte." }); return; }
    const result = await portalOrderDetail(res.locals.portalAccount, String(req.params.id), options.road);
    if (!await portalSession(req.cookies?.[PORTAL_COOKIE])) { res.status(401).json({ error: "Åtkomsten har upphört." }); return; }
    if (!result) { res.status(404).json({ error: "Ordern finns inte." }); return; }
    res.json(GetPortalOrderResponse.parse(result));
  });
  router.use((error: unknown, _req: import("express").Request, res: import("express").Response, _next: import("express").NextFunction) => {
    const status = error && typeof error === "object" && "statusCode" in error ? Number(error.statusCode) : 503;
    res.status([409, 422].includes(status) ? status : 503).json({ error: [409, 422].includes(status) && error instanceof Error ? error.message : "Kundportalen kunde inte nås. Försök igen." });
  });
  return router;
}
