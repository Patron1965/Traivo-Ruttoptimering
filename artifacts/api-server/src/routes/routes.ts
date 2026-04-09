import { Router, type IRouter } from "express";
import { CreateRouteBody, UpdateRouteBody, ListRoutesQueryParams } from "@workspace/api-zod";
import { handleError, parseUuidParam } from "../lib/errors";
import { getOrgId } from "../middleware/auth";
import * as routeService from "../services/route-service";

const router: IRouter = Router();

router.get("/routes", async (req, res) => {
  try {
    const { organizationId, status } = ListRoutesQueryParams.parse(req.query);
    const orgId = req.user?.organizationId ?? organizationId;
    const routes = await routeService.listRoutes(orgId, status);
    res.json(routes);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const route = await routeService.getRoute(id, orgId);
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(route);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/routes", async (req, res) => {
  try {
    const data = CreateRouteBody.parse(req.body);
    if (req.user) {
      data.organizationId = req.user.organizationId;
    }
    const route = await routeService.createRoute(data);
    res.status(201).json(route);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/routes/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const data = UpdateRouteBody.parse(req.body);
    const notifyFields: Record<string, boolean> = {};
    if (typeof req.body.notifyApproaching === "boolean") notifyFields.notifyApproaching = req.body.notifyApproaching;
    if (typeof req.body.notifyDelivered === "boolean") notifyFields.notifyDelivered = req.body.notifyDelivered;
    if (typeof req.body.notifyFailed === "boolean") notifyFields.notifyFailed = req.body.notifyFailed;

    const orgId = getOrgId(req);
    const route = await routeService.updateRoute(id, orgId, data, notifyFields);
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(route);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/routes/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const deleted = await routeService.deleteRoute(id, orgId);
    if (!deleted) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id/stops", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const stops = await routeService.getRouteStops(id, orgId);
    if (!stops) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(stops);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id/export", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const result = await routeService.exportRoute(id, orgId);
    if (!result) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    const { route, vehicleName, stops } = result;
    const lines = [
      "Sequence,Address,Latitude,Longitude,Time Window Start,Time Window End,Service Duration (min),Weight (kg),Notes",
    ];
    for (const stop of stops) {
      lines.push(
        [
          stop.sequenceOrder ?? "",
          `"${(stop.address || "").replace(/"/g, '""')}"`,
          stop.latitude,
          stop.longitude,
          stop.timeWindowStart ? stop.timeWindowStart.toISOString() : "",
          stop.timeWindowEnd ? stop.timeWindowEnd.toISOString() : "",
          stop.serviceDurationMin,
          stop.weightKg ?? "",
          `"${(stop.notes || "").replace(/"/g, '""')}"`,
        ].join(",")
      );
    }

    const header = `# Route: ${route.name}\n# Vehicle: ${vehicleName}\n# Distance: ${route.totalDistanceKm ?? 0} km\n# Duration: ${route.totalDurationMin ?? 0} min\n# CO2: ${route.co2EmissionsKg ?? 0} kg\n# Stops: ${route.totalStops}\n`;
    const csv = header + lines.join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="route-${route.name.replace(/[^a-zA-Z0-9]/g, "-")}.csv"`);
    res.send(csv);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/routes/:id/reorder-stops", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const { stopIds } = req.body as { stopIds: string[] };
    if (!Array.isArray(stopIds) || stopIds.length === 0) {
      res.status(400).json({ error: "stopIds array is required" });
      return;
    }
    const result = await routeService.reorderStops(id, orgId, stopIds);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.data);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/routes/:id/reschedule-failed", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const result = await routeService.rescheduleFailedStops(id, orgId);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json(result.data);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id/comparison", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const comparison = await routeService.getRouteComparison(id, orgId);
    if (!comparison) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(comparison);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
