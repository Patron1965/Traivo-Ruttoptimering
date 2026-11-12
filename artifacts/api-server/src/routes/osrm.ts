import { Router, type Request, type Response } from "express";
import { requireRole } from "../middleware/auth";
import { operationalProviderKind } from "../services/operational-provider-config";
import { fetchGeoapifyRoute } from "../services/geoapify-road";
import { assertOperationalRoadProvider } from "../services/road-data-policy";
import { handleError } from "../lib/errors";

const router = Router();

router.get("/osrm/route", requireRole("admin", "dispatcher", "driver", "viewer"), async (req: Request, res: Response) => {
  const coords = req.query.coords;
  const points = typeof coords === "string" ? coords.split(";").map(pair => {
    const parts = pair.split(",");
    return parts.length === 2 && parts.every(p => p.trim()) ? { lon: Number(parts[0]), lat: Number(parts[1]) } : { lon: NaN, lat: NaN };
  }) : [];
  if (points.length < 2 || points.length > 100 || !points.every(p =>
    Number.isFinite(p.lat) && Math.abs(p.lat) <= 90 && Number.isFinite(p.lon) && Math.abs(p.lon) <= 180)) {
    res.status(400).json({ error: "coords must contain 2 to 100 valid longitude,latitude pairs" });
    return;
  }

  try {
    assertOperationalRoadProvider();
    res.set("Cache-Control", "no-store");
    if (operationalProviderKind() === "geoapify") {
      const data = await fetchGeoapifyRoute(points);
      res.json(data);
      return;
    }
    const base = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
    const coordinateText = points.map(p => `${p.lon},${p.lat}`).join(";");
    const response = await fetch(`${base}/route/v1/driving/${coordinateText}?overview=full&geometries=polyline`, {
      signal: AbortSignal.timeout(30_000),
      headers: process.env.OSRM_AUTH_TOKEN ? { Authorization: `Bearer ${process.env.OSRM_AUTH_TOKEN}` } : {},
    });
    if (!response.ok) { res.status(502).json({ code: "Error", message: "Road geometry unavailable" }); return; }
    const data = await response.json();
    res.json(data);
  } catch (error) {
    handleError(res, error);
  }
});

export default router;
