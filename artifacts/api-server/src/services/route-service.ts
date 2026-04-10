import { eq, and } from "drizzle-orm";
import { db, routesTable, stopsTable, vehiclesTable, driversTable, driverPreferencesTable, deliveryNotificationsTable, routeHistoryTable, geofenceEventsTable, driverBehaviorLogsTable } from "@workspace/db";
import { dispatchWebhookEvent } from "./webhooks";
import { computeHappinessScore } from "./happiness-score";
import { broadcastDataChange } from "./realtime";
import { autoLogCompletedRoute } from "./driver-learning-service";

export interface CreateRouteData {
  organizationId: string;
  name: string;
  date?: Date;
  vehicleId?: string | null;
  status?: string;
  totalStops?: number;
  [key: string]: unknown;
}

export interface UpdateRouteData {
  name?: string;
  date?: Date;
  vehicleId?: string | null;
  status?: string;
  totalStops?: number;
  totalDistanceKm?: number | null;
  totalDurationMin?: number | null;
  co2EmissionsKg?: number | null;
  [key: string]: unknown;
}

export async function listRoutes(organizationId: string, status?: string) {
  const conditions = [eq(routesTable.organizationId, organizationId)];
  if (status) {
    conditions.push(eq(routesTable.status, status as any));
  }
  return db.select().from(routesTable).where(and(...conditions));
}

export async function getRoute(id: string, organizationId: string) {
  const [route] = await db
    .select()
    .from(routesTable)
    .where(and(eq(routesTable.id, id), eq(routesTable.organizationId, organizationId)));
  return route ?? null;
}

export async function createRoute(data: CreateRouteData) {
  const [route] = await db.insert(routesTable).values(data as any).returning();
  dispatchWebhookEvent(route.organizationId, "route.created", {
    routeId: route.id, name: route.name, status: route.status,
  }).catch(() => {});
  broadcastDataChange(route.organizationId, "route", "created", { id: route.id, name: route.name });
  return route;
}

export async function updateRoute(id: string, organizationId: string, data: UpdateRouteData, notifyFields: Record<string, boolean> = {}) {
  const conditions = [eq(routesTable.id, id), eq(routesTable.organizationId, organizationId)];
  const [route] = await db
    .update(routesTable)
    .set({ ...data, ...notifyFields, updatedAt: new Date() } as any)
    .where(and(...conditions))
    .returning();

  if (!route) return null;

  if (data.status === "completed" && route.vehicleId) {
    updateHappinessScoreForVehicle(route.vehicleId, route.organizationId).catch(() => {});
    autoLogCompletedRoute(route.id).catch(() => {});
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

  broadcastDataChange(route.organizationId, "route", "updated", { id: route.id, name: route.name, status: route.status });
  return route;
}

export async function deleteRoute(id: string, organizationId: string) {
  const [existing] = await db
    .select({ id: routesTable.id })
    .from(routesTable)
    .where(and(eq(routesTable.id, id), eq(routesTable.organizationId, organizationId)));
  if (!existing) return null;

  await db.delete(deliveryNotificationsTable).where(eq(deliveryNotificationsTable.routeId, id));
  await db.delete(routeHistoryTable).where(eq(routeHistoryTable.routeId, id));
  await db.delete(geofenceEventsTable).where(eq(geofenceEventsTable.routeId, id));
  await db.delete(driverBehaviorLogsTable).where(eq(driverBehaviorLogsTable.routeId, id));

  await db
    .update(stopsTable)
    .set({ routeId: null, sequenceOrder: null })
    .where(eq(stopsTable.routeId, id));

  const [deleted] = await db
    .delete(routesTable)
    .where(and(eq(routesTable.id, id), eq(routesTable.organizationId, organizationId)))
    .returning();
  if (deleted) {
    broadcastDataChange(organizationId, "route", "deleted", { id });
    broadcastDataChange(organizationId, "stop", "updated", { routeId: id, bulk: true });
  }
  return deleted ?? null;
}

export async function getRouteStops(routeId: string, organizationId: string) {
  const [route] = await db
    .select({ id: routesTable.id })
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  if (!route) return null;

  return db
    .select()
    .from(stopsTable)
    .where(eq(stopsTable.routeId, routeId))
    .orderBy(stopsTable.sequenceOrder);
}

export async function exportRoute(routeId: string, organizationId: string) {
  const [route] = await db
    .select()
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  if (!route) return null;

  let vehicleName = "Unassigned";
  if (route.vehicleId) {
    const [vehicle] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, route.vehicleId));
    if (vehicle) vehicleName = vehicle.name;
  }

  const stops = await db
    .select()
    .from(stopsTable)
    .where(eq(stopsTable.routeId, routeId))
    .orderBy(stopsTable.sequenceOrder);

  return { route, vehicleName, stops };
}

export async function reorderStops(routeId: string, organizationId: string, stopIds: string[]) {
  const [route] = await db
    .select()
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  if (!route) return { error: "Route not found", status: 404 };

  const uniqueIds = new Set(stopIds);
  if (uniqueIds.size !== stopIds.length) return { error: "stopIds must not contain duplicates", status: 400 };

  const existingStops = await db.select({ id: stopsTable.id }).from(stopsTable).where(eq(stopsTable.routeId, routeId));
  const existingIds = new Set(existingStops.map((s) => s.id));
  if (uniqueIds.size !== existingIds.size || !stopIds.every((sid) => existingIds.has(sid))) {
    return { error: "stopIds must match all stops in the route", status: 400 };
  }

  await db.transaction(async (tx) => {
    for (let i = 0; i < stopIds.length; i++) {
      await tx.update(stopsTable).set({ sequenceOrder: i + 1 }).where(and(eq(stopsTable.id, stopIds[i]), eq(stopsTable.routeId, routeId)));
    }
  });

  const updatedStops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, routeId)).orderBy(stopsTable.sequenceOrder);
  return { data: updatedStops };
}

export async function rescheduleFailedStops(routeId: string, organizationId: string) {
  const [route] = await db
    .select()
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  if (!route) return { error: "Route not found", status: 404 };

  const failedStops = await db
    .select()
    .from(stopsTable)
    .where(and(eq(stopsTable.routeId, routeId), eq(stopsTable.status, "failed")))
    .orderBy(stopsTable.sequenceOrder);
  if (failedStops.length === 0) return { error: "No failed stops to reschedule", status: 400 };

  const nextDay = new Date(route.date);
  nextDay.setDate(nextDay.getDate() + 1);

  const newRoute = await db.transaction(async (tx) => {
    const [created] = await tx.insert(routesTable).values({
      organizationId,
      name: `${route.name} (omplanerad)`,
      date: nextDay,
      vehicleId: route.vehicleId,
      totalStops: failedStops.length,
      status: "draft",
    }).returning();

    const stopsToInsert = failedStops.map((s, idx) => ({
      organizationId,
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

  return { data: newRoute };
}

function haversineKm(lat1: number, lon1: number, lat2: number, lon2: number) {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos((lat1 * Math.PI) / 180) * Math.cos((lat2 * Math.PI) / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

export async function getRouteComparison(routeId: string, organizationId: string) {
  const [route] = await db
    .select()
    .from(routesTable)
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
  if (!route) return null;

  let vehicle = null;
  if (route.vehicleId) {
    const [v] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, route.vehicleId));
    vehicle = v || null;
  }

  const stops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, routeId)).orderBy(stopsTable.sequenceOrder);
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

  return {
    route: { id: route.id, name: route.name, status: route.status, date: route.date, vehicleName: vehicle ? `${vehicle.name} (${vehicle.licensePlate})` : null },
    planned: { totalStops: stops.length, distanceKm: Math.round(plannedDistanceKm * 10) / 10, durationMin: plannedDurationMin, co2Kg: route.co2EmissionsKg || 0, coordinates: stops.map((s) => ({ lat: s.latitude, lng: s.longitude, address: s.address, status: s.status })) },
    actual: { completedStops: completedStops.length, failedStops: failedStops.length, skippedStops: skippedStops.length, pendingStops: pendingStops.length, distanceKm: Math.round(actualDistanceKm * 10) / 10, serviceDurationMin: actualServiceMin, completionRate, coordinates: completedStops.map((s) => ({ lat: s.latitude, lng: s.longitude, address: s.address })) },
    stops: stops.map((s) => ({ id: s.id, address: s.address, status: s.status, sequenceOrder: s.sequenceOrder, latitude: s.latitude, longitude: s.longitude, serviceDurationMin: s.serviceDurationMin })),
  };
}

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
      [prefs] = await db.insert(driverPreferencesTable).values({ driverId: driver.id }).returning();
    }
    const score = await computeHappinessScore(driver.id, organizationId, prefs);
    if (score !== prefs.happinessScore) {
      await db.update(driverPreferencesTable).set({ happinessScore: score }).where(eq(driverPreferencesTable.driverId, driver.id));
    }
  }
}
