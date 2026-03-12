import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, routesTable, stopsTable, vehiclesTable } from "@workspace/db";
import {
  CreateRouteBody,
  UpdateRouteBody,
  ListRoutesQueryParams,
} from "@workspace/api-zod";
import { handleError, parseUuidParam } from "../lib/errors";

const router: IRouter = Router();

router.get("/routes", async (req, res) => {
  try {
    const { organizationId, status } = ListRoutesQueryParams.parse(req.query);
    const conditions = [eq(routesTable.organizationId, organizationId)];
    if (status) {
      conditions.push(eq(routesTable.status, status));
    }
    const routes = await db
      .select()
      .from(routesTable)
      .where(and(...conditions));
    res.json(routes);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = req.query.organizationId as string | undefined;
    const conditions = [eq(routesTable.id, id)];
    if (orgId) conditions.push(eq(routesTable.organizationId, orgId));
    const [route] = await db
      .select()
      .from(routesTable)
      .where(and(...conditions));
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
    const [route] = await db.insert(routesTable).values(data).returning();
    res.status(201).json(route);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/routes/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const data = UpdateRouteBody.parse(req.body);
    const orgId = req.query.organizationId as string | undefined;
    const conditions = [eq(routesTable.id, id)];
    if (orgId) conditions.push(eq(routesTable.organizationId, orgId));
    const [route] = await db
      .update(routesTable)
      .set({ ...data, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
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
    const orgId = req.query.organizationId as string | undefined;
    const conditions = [eq(routesTable.id, id)];
    if (orgId) conditions.push(eq(routesTable.organizationId, orgId));

    await db
      .update(stopsTable)
      .set({ routeId: null, sequenceOrder: null })
      .where(eq(stopsTable.routeId, id));

    const [deleted] = await db
      .delete(routesTable)
      .where(and(...conditions))
      .returning();
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
    const stops = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, id))
      .orderBy(stopsTable.sequenceOrder);
    res.json(stops);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id/export", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = req.query.organizationId as string | undefined;
    const exportConditions = [eq(routesTable.id, id)];
    if (orgId) exportConditions.push(eq(routesTable.organizationId, orgId));
    const [route] = await db
      .select()
      .from(routesTable)
      .where(and(...exportConditions));
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    let vehicleName = "Unassigned";
    if (route.vehicleId) {
      const [vehicle] = await db
        .select()
        .from(vehiclesTable)
        .where(eq(vehiclesTable.id, route.vehicleId));
      if (vehicle) vehicleName = vehicle.name;
    }

    const stops = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, id))
      .orderBy(stopsTable.sequenceOrder);

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
    res.setHeader(
      "Content-Disposition",
      `attachment; filename="route-${route.name.replace(/[^a-zA-Z0-9]/g, "-")}.csv"`
    );
    res.send(csv);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
