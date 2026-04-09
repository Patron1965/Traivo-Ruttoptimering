import { Router } from "express";
import {
  getTrafficConditions,
  getStockholmTrafficOverview,
  addIncident,
  getActiveIncidents,
} from "../services/traffic-service";
import { requireAuth, requireRole } from "../middleware/auth";

const router = Router();

router.get("/traffic/conditions", (req, res) => {
  const lat = parseFloat(req.query.lat as string) || 59.33;
  const lng = parseFloat(req.query.lng as string) || 18.07;
  const condition = getTrafficConditions(lat, lng);
  res.json(condition);
});

router.get("/traffic/overview", (_req, res) => {
  const overview = getStockholmTrafficOverview();
  res.json(overview);
});

router.get("/traffic/incidents", (_req, res) => {
  res.json(getActiveIncidents());
});

router.post("/traffic/incidents", requireAuth(), requireRole("admin", "dispatcher"), (req, res) => {
  const { lat, lng, type, description, delayMinutes, radiusKm, durationMinutes } = req.body;

  if (!lat || !lng || !type || !description) {
    res.status(400).json({ error: "lat, lng, type, description required" });
    return;
  }

  const incident = addIncident({
    lat,
    lng,
    type,
    description,
    delayMinutes: delayMinutes ?? 10,
    radiusKm: radiusKm ?? 1,
    durationMinutes: durationMinutes ?? 60,
  });

  res.status(201).json(incident);
});

export default router;
