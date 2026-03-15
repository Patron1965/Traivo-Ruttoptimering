import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, routesTable, stopsTable, vehiclesTable, driversTable, driverPreferencesTable } from "@workspace/db";
import {
  CreateRouteBody,
  UpdateRouteBody,
  ListRoutesQueryParams,
} from "@workspace/api-zod";
import { handleError, parseUuidParam } from "../lib/errors";
import { computeHappinessScore } from "./driver-preferences";
import { dispatchWebhookEvent } from "../services/webhooks";

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
    dispatchWebhookEvent(route.organizationId, "route.created", {
      routeId: route.id, name: route.name, status: route.status,
    }).catch(() => {});
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

    const orgId = req.query.organizationId as string | undefined;
    const conditions = [eq(routesTable.id, id)];
    if (orgId) conditions.push(eq(routesTable.organizationId, orgId));
    const [route] = await db
      .update(routesTable)
      .set({ ...data, ...notifyFields, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    if (data.status === "completed" && route.vehicleId) {
      updateHappinessScoreForVehicle(route.vehicleId, route.organizationId).catch(() => {});
    }

    if (data.status) {
      const eventMap: Record<string, string> = {
        optimized: "route.optimized",
        in_progress: "route.started",
        completed: "route.completed",
        cancelled: "route.cancelled",
      };
      const event = eventMap[data.status];
      if (event) {
        dispatchWebhookEvent(route.organizationId, event, {
          routeId: route.id, name: route.name, status: route.status,
        }).catch(() => {});
      }
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

router.post("/routes/:id/reschedule-failed", async (req, res) => {
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

    const failedStops = await db
      .select()
      .from(stopsTable)
      .where(and(eq(stopsTable.routeId, id), eq(stopsTable.status, "failed")))
      .orderBy(stopsTable.sequenceOrder);

    if (failedStops.length === 0) {
      res.status(400).json({ error: "No failed stops to reschedule" });
      return;
    }

    const nextDay = new Date(route.date);
    nextDay.setDate(nextDay.getDate() + 1);

    const newRoute = await db.transaction(async (tx) => {
      const [created] = await tx
        .insert(routesTable)
        .values({
          organizationId: orgId,
          name: `${route.name} (omplanerad)`,
          date: nextDay,
          vehicleId: route.vehicleId,
          totalStops: failedStops.length,
          status: "draft",
        })
        .returning();

      const stopsToInsert = failedStops.map((s, idx) => ({
        organizationId: orgId,
        routeId: created.id,
        customerId: s.customerId,
        address: s.address,
        latitude: s.latitude,
        longitude: s.longitude,
        serviceDurationMin: s.serviceDurationMin,
        weightKg: s.weightKg,
        volumeM3: s.volumeM3,
        notes: s.notes ? `Omplanerad: ${s.notes}` : "Omplanerad från misslyckad leverans",
        sequenceOrder: idx + 1,
        timeWindowStart: s.timeWindowStart,
        timeWindowEnd: s.timeWindowEnd,
        status: "pending" as const,
      }));
      await tx.insert(stopsTable).values(stopsToInsert);

      return created;
    });

    res.status(201).json(newRoute);
  } catch (err) {
    handleError(res, err);
  }
});

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

router.get("/routes/:id/comparison", async (req, res) => {
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

    let vehicle = null;
    if (route.vehicleId) {
      const [v] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, route.vehicleId));
      vehicle = v || null;
    }

    const stops = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, id))
      .orderBy(stopsTable.sequenceOrder);

    const plannedCoords = stops.map((s) => ({ lat: s.latitude, lng: s.longitude, address: s.address, status: s.status }));
    const completedStops = stops.filter((s) => s.status === "completed");
    const failedStops = stops.filter((s) => s.status === "failed");
    const skippedStops = stops.filter((s) => s.status === "skipped");
    const pendingStops = stops.filter((s) => s.status === "pending" || s.status === "in_progress");

    let plannedDistanceKm = 0;
    for (let i = 1; i < stops.length; i++) {
      plannedDistanceKm += haversineKm(stops[i - 1].latitude, stops[i - 1].longitude, stops[i].latitude, stops[i].longitude);
    }

    let actualDistanceKm = 0;
    for (let i = 1; i < completedStops.length; i++) {
      actualDistanceKm += haversineKm(completedStops[i - 1].latitude, completedStops[i - 1].longitude, completedStops[i].latitude, completedStops[i].longitude);
    }

    const plannedDurationMin = route.totalDurationMin || stops.length * 15;
    const actualServiceMin = completedStops.reduce((sum, s) => sum + (s.serviceDurationMin || 15), 0);

    const completionRate = stops.length > 0 ? Math.round((completedStops.length / stops.length) * 100) : 0;

    res.json({
      route: {
        id: route.id,
        name: route.name,
        status: route.status,
        date: route.date,
        vehicleName: vehicle ? `${vehicle.name} (${vehicle.licensePlate})` : null,
      },
      planned: {
        totalStops: stops.length,
        distanceKm: Math.round(plannedDistanceKm * 10) / 10,
        durationMin: plannedDurationMin,
        co2Kg: route.co2EmissionsKg || 0,
        coordinates: plannedCoords,
      },
      actual: {
        completedStops: completedStops.length,
        failedStops: failedStops.length,
        skippedStops: skippedStops.length,
        pendingStops: pendingStops.length,
        distanceKm: Math.round(actualDistanceKm * 10) / 10,
        serviceDurationMin: actualServiceMin,
        completionRate,
        coordinates: completedStops.map((s) => ({ lat: s.latitude, lng: s.longitude, address: s.address })),
      },
      stops: stops.map((s) => ({
        id: s.id,
        address: s.address,
        status: s.status,
        sequenceOrder: s.sequenceOrder,
        latitude: s.latitude,
        longitude: s.longitude,
        serviceDurationMin: s.serviceDurationMin,
      })),
    });
  } catch (err) {
    handleError(res, err);
  }
});

async function updateHappinessScoreForVehicle(vehicleId: string, organizationId: string) {
  const drivers = await db
    .select()
    .from(driversTable)
    .where(and(eq(driversTable.vehicleId, vehicleId), eq(driversTable.organizationId, organizationId)));

  for (const driver of drivers) {
    let [prefs] = await db
      .select()
      .from(driverPreferencesTable)
      .where(eq(driverPreferencesTable.driverId, driver.id));

    if (!prefs) {
      [prefs] = await db
        .insert(driverPreferencesTable)
        .values({ driverId: driver.id })
        .returning();
    }

    const score = await computeHappinessScore(driver.id, organizationId, prefs);
    if (score !== prefs.happinessScore) {
      await db
        .update(driverPreferencesTable)
        .set({ happinessScore: score })
        .where(eq(driverPreferencesTable.driverId, driver.id));
    }
  }
}

export default router;
