import { Router } from "express";
import {
  getDriverLearningInsights,
  getDriverBehaviorLogs,
  getLearnedProfile,
  autoLogCompletedRoute,
  logRouteBehavior,
  verifyDriverBelongsToOrg,
} from "../services/driver-learning-service";
import { requireAuth, requireRole, getOrgId } from "../middleware/auth";

const router = Router();

function getStringParam(value: string | string[]): string {
  if (typeof value !== "string") {
    throw new Error("Invalid route parameter");
  }
  return value;
}

router.get("/drivers/:driverId/learning", requireAuth(), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const driverId = getStringParam(req.params.driverId);
    const valid = await verifyDriverBelongsToOrg(driverId, orgId);
    if (!valid) { res.status(404).json({ error: "Driver not found" }); return; }
    const insights = await getDriverLearningInsights(driverId);
    res.json(insights);
  } catch (err) {
    console.error("Error fetching driver learning insights:", err);
    res.status(500).json({ error: "Failed to fetch learning insights" });
  }
});

router.get("/drivers/:driverId/learning/profile", requireAuth(), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const driverId = getStringParam(req.params.driverId);
    const valid = await verifyDriverBelongsToOrg(driverId, orgId);
    if (!valid) { res.status(404).json({ error: "Driver not found" }); return; }
    const profile = await getLearnedProfile(driverId);
    if (!profile) {
      res.json({ exists: false, message: "Ingen inlärningsprofil ännu" });
      return;
    }
    res.json({ exists: true, profile });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch learned profile" });
  }
});

router.get("/drivers/:driverId/learning/logs", requireAuth(), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const driverId = getStringParam(req.params.driverId);
    const valid = await verifyDriverBelongsToOrg(driverId, orgId);
    if (!valid) { res.status(404).json({ error: "Driver not found" }); return; }
    const limit = parseInt(req.query.limit as string) || 20;
    const logs = await getDriverBehaviorLogs(driverId, limit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch behavior logs" });
  }
});

router.post("/drivers/:driverId/learning/log", requireAuth(), requireRole("admin", "dispatcher"), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const driverId = getStringParam(req.params.driverId);
    const valid = await verifyDriverBelongsToOrg(driverId, orgId);
    if (!valid) { res.status(404).json({ error: "Driver not found" }); return; }
    const log = await logRouteBehavior({
      driverId,
      ...req.body,
    });
    res.status(201).json(log);
  } catch (err) {
    console.error("Error logging driver behavior:", err);
    res.status(500).json({ error: "Failed to log behavior" });
  }
});

router.post("/routes/:routeId/auto-log", requireAuth(), requireRole("admin", "dispatcher"), async (req, res) => {
  try {
    const routeId = getStringParam(req.params.routeId);
    const log = await autoLogCompletedRoute(routeId, req.user!.organizationId);
    if (!log) {
      res.json({ logged: false, message: "Route not eligible for auto-logging" });
      return;
    }
    res.status(201).json({ logged: true, log });
  } catch (err) {
    console.error("Error auto-logging route:", err);
    res.status(500).json({ error: "Failed to auto-log route" });
  }
});

export default router;
