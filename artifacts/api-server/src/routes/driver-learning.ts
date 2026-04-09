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

router.get("/drivers/:driverId/learning", requireAuth(), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const valid = await verifyDriverBelongsToOrg(req.params.driverId, orgId);
    if (!valid) { res.status(404).json({ error: "Driver not found" }); return; }
    const insights = await getDriverLearningInsights(req.params.driverId);
    res.json(insights);
  } catch (err) {
    console.error("Error fetching driver learning insights:", err);
    res.status(500).json({ error: "Failed to fetch learning insights" });
  }
});

router.get("/drivers/:driverId/learning/profile", requireAuth(), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const valid = await verifyDriverBelongsToOrg(req.params.driverId, orgId);
    if (!valid) { res.status(404).json({ error: "Driver not found" }); return; }
    const profile = await getLearnedProfile(req.params.driverId);
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
    const valid = await verifyDriverBelongsToOrg(req.params.driverId, orgId);
    if (!valid) { res.status(404).json({ error: "Driver not found" }); return; }
    const limit = parseInt(req.query.limit as string) || 20;
    const logs = await getDriverBehaviorLogs(req.params.driverId, limit);
    res.json(logs);
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch behavior logs" });
  }
});

router.post("/drivers/:driverId/learning/log", requireAuth(), requireRole("admin", "dispatcher"), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const valid = await verifyDriverBelongsToOrg(req.params.driverId, orgId);
    if (!valid) { res.status(404).json({ error: "Driver not found" }); return; }
    const log = await logRouteBehavior({
      driverId: req.params.driverId,
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
    const log = await autoLogCompletedRoute(req.params.routeId);
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
