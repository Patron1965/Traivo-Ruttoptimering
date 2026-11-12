import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { redeemDriverAccessLink, revokeDriverAccess } from "../services/driver-access";
import { requireRole } from "../middleware/auth";
import { logSecurityEvent } from "../lib/security-log";

export const driverAccessRouter = Router();
driverAccessRouter.use((_req, res, next) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" }); next();
});
driverAccessRouter.post("/auth/driver-link", rateLimit({
  windowMs: 60_000, max: 10, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => { res.status(429).json({ code: "RATE_LIMITED", error: "Vänta en stund och försök igen." }); },
}), async (req, res) => {
  const input = z.object({ token: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).safeParse(req.body);
  if (!input.success) { res.status(401).json({ code: "DRIVER_LINK_INVALID" }); return; }
  try {
    // Deliberately ignore cookies: only the driver's stored device bearer may
    // resume a consumed link, never an office administrator's browser session.
    const authorization = req.headers.authorization;
    const deviceToken = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
    const result = await redeemDriverAccessLink(input.data.token, deviceToken);
    await logSecurityEvent({ req, action: "driver.access.activated", statusCode: 200,
      organizationId: result.user.organizationId, userId: result.user.id });
    // No staff cookie: device bearer is separate from browser office sessions.
    res.json(result);
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "DRIVER_LINK_INVALID") {
      res.status(401).json({ code: "DRIVER_LINK_INVALID" }); return;
    }
    res.status(503).json({ code: "DRIVER_ACCESS_UNAVAILABLE" });
  }
});
driverAccessRouter.post("/drivers/:id/revoke-access", requireRole("admin", "dispatcher"), async (req, res) => {
  if (!z.guid().safeParse(req.params.id).success) { res.sendStatus(400); return; }
  try {
    const result = await revokeDriverAccess(req.params.id as string, req.user!.organizationId);
    await logSecurityEvent({ req, action: "driver.access.revoked", statusCode: 200,
      organizationId: req.user!.organizationId, userId: req.user!.id });
    res.json(result);
  } catch { res.status(404).json({ error: "Föraren finns inte." }); }
});
