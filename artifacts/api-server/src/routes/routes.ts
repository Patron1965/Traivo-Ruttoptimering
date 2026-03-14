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
    const orgId = req.query.organizationId as string | undefined;
    if (orgId) {
      const [route] = await db
        .select({ id: routesTable.id })
        .from(routesTable)
        .where(and(eq(routesTable.id, id), eq(routesTable.organizationId, orgId)));
      if (!route) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
    }
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
    const orgId = req.query.organizationId as string;
    if (!orgId) {
      res.status(400).json({ error: "organizationId query parameter is required" });
      return;
    }
    const [route] = await db
      .select()
      .from(routesTable)
      .where(and(eq(routesTable.id, id), eq(routesTable.organizationId, orgId)));
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

router.put("/routes/:id/reorder-stops", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = req.query.organizationId as string;
    if (!orgId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    const [route] = await db
      .select()
      .from(routesTable)
      .where(and(eq(routesTable.id, id), eq(routesTable.organizationId, orgId)));
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    const { stopIds } = req.body as { stopIds: string[] };
    if (!Array.isArray(stopIds) || stopIds.length === 0) {
      res.status(400).json({ error: "stopIds array is required" });
      return;
    }

    const uniqueIds = new Set(stopIds);
    if (uniqueIds.size !== stopIds.length) {
      res.status(400).json({ error: "stopIds must not contain duplicates" });
      return;
    }

    const existingStops = await db
      .select({ id: stopsTable.id })
      .from(stopsTable)
      .where(eq(stopsTable.routeId, id));
    const existingIds = new Set(existingStops.map((s) => s.id));

    if (uniqueIds.size !== existingIds.size || !stopIds.every((sid) => existingIds.has(sid))) {
      res.status(400).json({ error: "stopIds must match all stops in the route" });
      return;
    }

    await db.transaction(async (tx) => {
      for (let i = 0; i < stopIds.length; i++) {
        await tx
          .update(stopsTable)
          .set({ sequenceOrder: i + 1 })
          .where(and(eq(stopsTable.id, stopIds[i]), eq(stopsTable.routeId, id)));
      }
    });

    const updatedStops = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, id))
      .orderBy(stopsTable.sequenceOrder);

    res.json(updatedStops);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
