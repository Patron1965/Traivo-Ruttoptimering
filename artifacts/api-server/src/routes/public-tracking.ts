import { Router, type IRouter } from "express";
import rateLimit from "express-rate-limit";
import { readPublicCustomerLink } from "../services/customer-links";
import { directionalRoad, type RoadAdapter } from "../services/customer-live-tracking";

export function privateLinkHeaders(_req: unknown, res: import("express").Response, next: () => void) {
  res.set({ "Cache-Control": "no-store, private", "Pragma": "no-cache", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive" });
  next();
}
const invalid = { error: "Länken är inte tillgänglig.", code: "TRACKING_UNAVAILABLE" };
export function createPublicTrackingRouter(roadAdapter: RoadAdapter = directionalRoad): IRouter {
const router: IRouter = Router();
router.use("/track", privateLinkHeaders);
router.use("/track", rateLimit({
  windowMs: 60_000, limit: 60, standardHeaders: true, legacyHeaders: false,
  handler: (_req, res) => { res.status(429).json(invalid); },
}));
router.get("/track/:code", async (req, res) => {
  try {
    const result = await readPublicCustomerLink(String(req.params.code), roadAdapter);
    if (!result) { res.status(404).json(invalid); return; }
    res.json(result);
  } catch {
    // Never pass a token-bearing URL or database query/parameters to a logger.
    res.status(503).json(invalid);
  }
});
return router;
}
export default createPublicTrackingRouter();