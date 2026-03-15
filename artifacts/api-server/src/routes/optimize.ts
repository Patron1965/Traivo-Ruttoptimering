import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, vehiclesTable, stopsTable, routesTable, notificationsTable, driversTable, driverPreferencesTable } from "@workspace/db";
import { OptimizeRoutesBody } from "@workspace/api-zod";
import { handleError } from "../lib/errors";
import crypto from "crypto";
import { z } from "zod";
import { estimateDurationMinPredictive, getTrafficDescription } from "../services/eta";
import {
  optimizeWithALNS,
  reoptimizeAffectedRoutes,
  haversineDistance,
  estimateCo2,
  cachedDistance,
  getDistanceCache,
  type ALNSNode,
  type ALNSVehicle,
  type ALNSRoute,
  type ALNSConfig,
  type ALNSDriverConstraints,
  type OptimizationWeights,
} from "../services/alns";
import { broadcast } from "../ws";
import {
  ContinuousOptimizer,
  getActiveOptimizer,
  setActiveOptimizer,
  removeActiveOptimizer,
} from "../services/continuous-optimizer";

function generateTrackingCodeRaw(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = crypto.randomBytes(4);
  let code = "RT-";
  for (let i = 0; i < 4; i++) {
    code += chars[random[i] % chars.length];
  }
  return code;
}

async function generateUniqueTrackingCode(): Promise<string> {
  const MAX_RETRIES = 10;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    const code = generateTrackingCodeRaw();
    const existing = await db
      .select({ id: stopsTable.id })
      .from(stopsTable)
      .where(eq(stopsTable.trackingCode, code))
      .limit(1);
    if (existing.length === 0) return code;
  }
  const fallback = crypto.randomBytes(6).toString("hex").toUpperCase();
  return `RT-${fallback}`;
}

const EMISSION_PROFILES: Record<string, { gCo2PerKm: number; loadFactor: number }> = {
  fossil:   { gCo2PerKm: 210, loadFactor: 1.15 },
  electric: { gCo2PerKm: 50,  loadFactor: 1.05 },
};

function estimateDurationMin(distanceKm: number, departureTime?: Date): number {
  if (departureTime) {
    return estimateDurationMinPredictive(distanceKm, departureTime);
  }
  const avgSpeedKmH = 35;
  return (distanceKm / avgSpeedKmH) * 60;
}

const OptimizationWeightsSchema = z.object({
  distanceWeight: z.number().min(0).max(1).optional().default(0.45),
  co2Weight: z.number().min(0).max(1).optional().default(0.25),
  etaPrecisionWeight: z.number().min(0).max(1).optional().default(0.15),
  driverHappinessWeight: z.number().min(0).max(1).optional().default(0.15),
});

function normalizeWeights(w: { distanceWeight: number; co2Weight: number; etaPrecisionWeight: number; driverHappinessWeight: number }): OptimizationWeights {
  const sum = w.distanceWeight + w.co2Weight + w.etaPrecisionWeight + w.driverHappinessWeight;
  if (sum === 0) return { distanceWeight: 0.45, co2Weight: 0.25, etaPrecisionWeight: 0.15, driverHappinessWeight: 0.15 };
  return {
    distanceWeight: w.distanceWeight / sum,
    co2Weight: w.co2Weight / sum,
    etaPrecisionWeight: w.etaPrecisionWeight / sum,
    driverHappinessWeight: w.driverHappinessWeight / sum,
  };
}

const ExtendedOptimizeBody = OptimizeRoutesBody.extend({
  optimizationWeights: OptimizationWeightsSchema.optional(),
  timeBudgetMs: z.number().min(1000).max(30000).optional().default(30000),
});

const ReoptimizeBody = z.object({
  organizationId: z.string().uuid(),
  routeIds: z.array(z.string().uuid()).optional(),
  reason: z.string().optional(),
  depotLatitude: z.number().optional(),
  depotLongitude: z.number().optional(),
  disruptionType: z.enum(["traffic_delay", "stop_added", "stop_cancelled", "vehicle_breakdown"]).optional(),
  affectedStopId: z.string().uuid().optional(),
});

const router: IRouter = Router();

router.post("/optimize", async (req, res) => {
  try {
    const parsed = ExtendedOptimizeBody.parse(req.body);
    const { organizationId, vehicleIds, stopIds, depotLatitude, depotLongitude, timeBudgetMs } = parsed;

    const weights = normalizeWeights({
      distanceWeight: parsed.optimizationWeights?.distanceWeight ?? 0.45,
      co2Weight: parsed.optimizationWeights?.co2Weight ?? 0.25,
      etaPrecisionWeight: parsed.optimizationWeights?.etaPrecisionWeight ?? 0.15,
      driverHappinessWeight: parsed.optimizationWeights?.driverHappinessWeight ?? 0.15,
    });

    const vehicles = await db
      .select()
      .from(vehiclesTable)
      .where(
        and(
          inArray(vehiclesTable.id, vehicleIds),
          eq(vehiclesTable.organizationId, organizationId)
        )
      );

    if (vehicles.length !== vehicleIds.length) {
      res.status(400).json({ error: "One or more vehicles do not belong to the specified organization" });
      return;
    }

    const stops = await db
      .select()
      .from(stopsTable)
      .where(
        and(
          inArray(stopsTable.id, stopIds),
          eq(stopsTable.organizationId, organizationId)
        )
      );

    if (stops.length !== stopIds.length) {
      res.status(400).json({ error: "One or more stops do not belong to the specified organization" });
      return;
    }

    const alnsNodes: ALNSNode[] = stops.map(s => ({
      id: s.id,
      latitude: s.latitude,
      longitude: s.longitude,
      timeWindowStart: s.timeWindowStart,
      timeWindowEnd: s.timeWindowEnd,
      serviceDurationMin: s.serviceDurationMin,
      weightKg: Number(s.weightKg) || 0,
      volumeM3: Number(s.volumeM3) || 0,
    }));

    const alnsVehicles: ALNSVehicle[] = vehicles.map(v => ({
      id: v.id,
      vehicleType: v.vehicleType,
      capacityKg: v.capacityKg,
      capacityVolume: v.capacityVolume,
      rangeKm: v.rangeKm,
    }));

    const orgDrivers = await db
      .select()
      .from(driversTable)
      .where(
        and(
          eq(driversTable.organizationId, organizationId),
          eq(driversTable.isActive, true)
        )
      );
    const drivers = orgDrivers.filter(d => d.vehicleId && vehicleIds.includes(d.vehicleId));

    const driverConstraints: ALNSDriverConstraints[] = [];
    if (drivers.length > 0) {
      const driverIds = drivers.map(d => d.id);
      const allPrefs = await db
        .select()
        .from(driverPreferencesTable)
        .where(inArray(driverPreferencesTable.driverId, driverIds));

      const prefsMap = new Map(allPrefs.map(p => [p.driverId, p]));
      for (const driver of drivers) {
        if (!driver.vehicleId) continue;
        const prefs = prefsMap.get(driver.id);
        driverConstraints.push({
          vehicleId: driver.vehicleId,
          driverName: driver.name,
          preferredStartTime: prefs?.preferredStartTime ?? "07:00:00",
          preferredEndTime: prefs?.preferredEndTime ?? "16:00:00",
          maxDrivingHoursPerDay: prefs?.maxDrivingHoursPerDay ?? 8,
          avoidNightDriving: prefs?.avoidNightDriving ?? false,
          breakFrequencyMinutes: prefs?.breakFrequencyMinutes ?? 120,
          preferredBreakDurationMin: prefs?.preferredBreakDurationMin ?? 15,
        });
      }
    }

    const startTime = new Date();
    const result = optimizeWithALNS(
      alnsNodes,
      alnsVehicles,
      depotLatitude,
      depotLongitude,
      startTime,
      { weights, timeLimitMs: timeBudgetMs, driverConstraints }
    );

    const optimizedRoutes = [];
    let totalDistanceKm = 0;
    let totalDurationMin = 0;

    for (const alnsRoute of result.routes) {
      if (alnsRoute.nodes.length === 0) continue;

      const vehicle = vehicles.find(v => v.id === alnsRoute.vehicleId);
      if (!vehicle) continue;

      const [route] = await db
        .insert(routesTable)
        .values({
          organizationId,
          vehicleId: vehicle.id,
          name: `${vehicle.name} - Optimized`,
          date: new Date(),
          status: "optimized",
          totalStops: alnsRoute.nodes.filter(n => !n.isChargingStation).length,
        })
        .returning();

      let routeDistance = 0;
      let routeDuration = 0;
      const optimizedStops: Array<{
        stopId: string;
        sequenceOrder: number;
        estimatedArrival: string;
        distanceFromPreviousKm: number;
        isChargingStop?: boolean;
        chargingStationName?: string;
      }> = [];
      let currentTime = new Date();
      let seqOrder = 0;
      let prevLat = depotLatitude;
      let prevLon = depotLongitude;

      for (const node of alnsRoute.nodes) {
        const dist = cachedDistance(prevLat, prevLon, node.latitude, node.longitude);
        const dur = estimateDurationMin(dist, currentTime);

        routeDistance += dist;
        const arrivalTime = new Date(currentTime.getTime() + dur * 60000);

        seqOrder++;

        if (node.isChargingStation) {
          const chargeDur = node.chargingDurationMin ?? 30;
          routeDuration += dur + chargeDur;

          optimizedStops.push({
            stopId: node.id,
            sequenceOrder: seqOrder,
            estimatedArrival: arrivalTime.toISOString(),
            distanceFromPreviousKm: Math.round(dist * 100) / 100,
            isChargingStop: true,
            chargingStationName: node.chargingStationName,
          });

          currentTime = new Date(arrivalTime.getTime() + chargeDur * 60000);
        } else {
          routeDuration += dur + node.serviceDurationMin;

          const effectiveStart = node.timeWindowStart && node.timeWindowStart.getTime() > arrivalTime.getTime()
            ? node.timeWindowStart
            : arrivalTime;

          const trackingCode = await generateUniqueTrackingCode();
          await db
            .update(stopsTable)
            .set({ routeId: route.id, sequenceOrder: seqOrder, trackingCode })
            .where(and(eq(stopsTable.id, node.id), eq(stopsTable.organizationId, organizationId)));

          optimizedStops.push({
            stopId: node.id,
            sequenceOrder: seqOrder,
            estimatedArrival: effectiveStart.toISOString(),
            distanceFromPreviousKm: Math.round(dist * 100) / 100,
          });

          currentTime = new Date(effectiveStart.getTime() + node.serviceDurationMin * 60000);
        }

        prevLat = node.latitude;
        prevLon = node.longitude;
      }

      const co2 = estimateCo2(routeDistance, vehicle.vehicleType, alnsRoute.totalWeight, vehicle.capacityKg);

      await db
        .update(routesTable)
        .set({
          totalDistanceKm: Math.round(routeDistance * 100) / 100,
          totalDurationMin: Math.round(routeDuration * 100) / 100,
          co2EmissionsKg: Math.round(co2 * 100) / 100,
        })
        .where(eq(routesTable.id, route.id));

      totalDistanceKm += routeDistance;
      totalDurationMin += routeDuration;

      const chargingCount = alnsRoute.nodes.filter(n => n.isChargingStation).length;

      optimizedRoutes.push({
        vehicleId: vehicle.id,
        routeId: route.id,
        stops: optimizedStops,
        distanceKm: Math.round(routeDistance * 100) / 100,
        durationMin: Math.round(routeDuration * 100) / 100,
        co2EmissionsKg: Math.round(co2 * 100) / 100,
        chargingStopsInserted: chargingCount,
      });
    }

    const routeDate = (req.body as Record<string, unknown>).date
      ? new Date((req.body as Record<string, unknown>).date as string)
      : new Date();

    res.json({
      routes: optimizedRoutes,
      totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
      totalDurationMin: Math.round(totalDurationMin * 100) / 100,
      unassignedStopIds: result.unassigned.map(n => n.id),
      trafficCondition: getTrafficDescription(routeDate),
      etaModel: "predictive",
      optimizer: "alns",
      optimizationWeights: weights,
      driverConstraintsApplied: driverConstraints.map(dc => ({
        vehicleId: dc.vehicleId,
        driverName: dc.driverName,
        maxHours: dc.maxDrivingHoursPerDay,
        avoidNight: dc.avoidNightDriving,
        preferredWindow: `${dc.preferredStartTime.slice(0, 5)} - ${dc.preferredEndTime.slice(0, 5)}`,
      })),
      costBreakdown: {
        totalDistanceKm: Math.round(result.costBreakdown.totalDistanceKm * 100) / 100,
        totalCo2Kg: Math.round(result.costBreakdown.totalCo2Kg * 100) / 100,
        totalTimeWindowSlackMin: Math.round(result.costBreakdown.totalTimeWindowSlackMin * 100) / 100,
        totalDriverPenalty: Math.round(result.costBreakdown.totalDriverPenalty * 100) / 100,
        driverPenaltyCost: Math.round(result.costBreakdown.driverPenaltyCost * 100) / 100,
      },
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/optimize/reoptimize", async (req, res) => {
  try {
    const { organizationId, routeIds: suppliedRouteIds, reason, depotLatitude, depotLongitude, disruptionType, affectedStopId } = ReoptimizeBody.parse(req.body);

    let affectedRouteIds: string[] = suppliedRouteIds ?? [];
    let additionalStopIds: string[] = [];

    if (affectedRouteIds.length === 0 && disruptionType) {
      if (disruptionType === "stop_added") {
        if (!affectedStopId) {
          res.status(400).json({ error: "affectedStopId is required for stop_added disruptions" });
          return;
        }
        const [newStop] = await db.select().from(stopsTable).where(and(eq(stopsTable.id, affectedStopId), eq(stopsTable.organizationId, organizationId)));
        if (!newStop) {
          res.status(404).json({ error: "Affected stop not found" });
          return;
        }
        if (newStop.routeId) {
          affectedRouteIds = [newStop.routeId];
        } else {
          additionalStopIds = [newStop.id];
          const activeRoutes = await db.select().from(routesTable).where(
            and(eq(routesTable.organizationId, organizationId), eq(routesTable.status, "optimized"))
          );
          if (activeRoutes.length === 0) {
            res.status(400).json({ error: "No optimized routes available to absorb the new stop" });
            return;
          }
          const nearestRoutes = [];
          for (const route of activeRoutes) {
            const routeStops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, route.id));
            const minDist = Math.min(...routeStops.map(s =>
              haversineDistance(newStop.latitude, newStop.longitude, s.latitude, s.longitude)
            ), Infinity);
            nearestRoutes.push({ route, minDist });
          }
          nearestRoutes.sort((a, b) => a.minDist - b.minDist);
          affectedRouteIds = nearestRoutes.slice(0, 2).map(r => r.route.id);
        }
      } else if (disruptionType === "stop_cancelled") {
        if (!affectedStopId) {
          res.status(400).json({ error: "affectedStopId is required for stop_cancelled disruptions" });
          return;
        }
        const [cancelledStop] = await db.select().from(stopsTable).where(and(eq(stopsTable.id, affectedStopId), eq(stopsTable.organizationId, organizationId)));
        if (cancelledStop?.routeId) {
          affectedRouteIds = [cancelledStop.routeId];
        } else {
          res.status(400).json({ error: "Cancelled stop has no assigned route to re-optimize" });
          return;
        }
      } else if (disruptionType === "traffic_delay") {
        if (!suppliedRouteIds || suppliedRouteIds.length === 0) {
          res.status(400).json({ error: "routeIds are required for traffic_delay disruptions to scope affected routes" });
          return;
        }
      } else if (disruptionType === "vehicle_breakdown") {
        if (!suppliedRouteIds || suppliedRouteIds.length === 0) {
          res.status(400).json({ error: "routeIds are required for vehicle_breakdown disruptions" });
          return;
        }
      }
    }

    if (affectedRouteIds.length === 0) {
      res.status(400).json({ error: "Could not determine affected routes. Provide routeIds or a disruptionType with affectedStopId." });
      return;
    }

    const affectedRoutes = await db
      .select()
      .from(routesTable)
      .where(
        and(
          inArray(routesTable.id, affectedRouteIds),
          eq(routesTable.organizationId, organizationId)
        )
      );

    if (affectedRoutes.length === 0) {
      res.status(404).json({ error: "No matching routes found" });
      return;
    }

    const affectedVehicleIds = affectedRoutes.map(r => r.vehicleId).filter((id): id is string => id !== null);
    const allOrgVehicles = await db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));

    const allAffectedStops: (typeof stopsTable.$inferSelect)[] = [];
    for (const route of affectedRoutes) {
      const routeStops = await db
        .select()
        .from(stopsTable)
        .where(
          and(
            eq(stopsTable.routeId, route.id),
            eq(stopsTable.organizationId, organizationId)
          )
        );
      allAffectedStops.push(...routeStops);
    }

    const pendingStops = allAffectedStops.filter(s => s.status === "pending");

    let extraUnassignedStops: typeof pendingStops = [];
    if (additionalStopIds.length > 0) {
      const extras = await db.select().from(stopsTable).where(and(inArray(stopsTable.id, additionalStopIds), eq(stopsTable.organizationId, organizationId)));
      extraUnassignedStops = extras.filter(s => s.status === "pending");
      pendingStops.push(...extraUnassignedStops);
    }

    const currentALNSRoutes: ALNSRoute[] = affectedRoutes.map((r, idx) => {
      const routeStops = allAffectedStops.filter(s => s.routeId === r.id && s.status === "pending");
      const nodes: ALNSNode[] = routeStops.map(s => ({
        id: s.id,
        latitude: s.latitude,
        longitude: s.longitude,
        timeWindowStart: s.timeWindowStart,
        timeWindowEnd: s.timeWindowEnd,
        serviceDurationMin: s.serviceDurationMin,
        weightKg: Number(s.weightKg) || 0,
        volumeM3: Number(s.volumeM3) || 0,
      }));
      if (idx === 0) {
        for (const extra of extraUnassignedStops) {
          nodes.push({
            id: extra.id,
            latitude: extra.latitude,
            longitude: extra.longitude,
            timeWindowStart: extra.timeWindowStart,
            timeWindowEnd: extra.timeWindowEnd,
            serviceDurationMin: extra.serviceDurationMin,
            weightKg: Number(extra.weightKg) || 0,
            volumeM3: Number(extra.volumeM3) || 0,
          });
        }
      }
      return {
        vehicleId: r.vehicleId ?? "",
        nodes,
        totalWeight: nodes.reduce((sum, n) => sum + (n.weightKg ?? 0), 0),
        totalVolume: nodes.reduce((sum, n) => sum + (n.volumeM3 ?? 0), 0),
      };
    });

    const alnsVehicles: ALNSVehicle[] = allOrgVehicles.map(v => ({
      id: v.id,
      vehicleType: v.vehicleType,
      capacityKg: v.capacityKg,
      capacityVolume: v.capacityVolume,
      rangeKm: v.rangeKm,
    }));

    const startTime = new Date();
    const depLat = depotLatitude ?? 59.3293;
    const depLon = depotLongitude ?? 18.0686;

    const reoptDrivers = await db
      .select()
      .from(driversTable)
      .where(
        and(
          eq(driversTable.organizationId, organizationId),
          eq(driversTable.isActive, true)
        )
      );
    const reoptDriversFiltered = reoptDrivers.filter(d => d.vehicleId && affectedVehicleIds.includes(d.vehicleId));
    const reoptDriverConstraints: ALNSDriverConstraints[] = [];
    if (reoptDriversFiltered.length > 0) {
      const dIds = reoptDriversFiltered.map(d => d.id);
      const dPrefs = await db.select().from(driverPreferencesTable).where(inArray(driverPreferencesTable.driverId, dIds));
      const pMap = new Map(dPrefs.map(p => [p.driverId, p]));
      for (const drv of reoptDriversFiltered) {
        if (!drv.vehicleId) continue;
        const p = pMap.get(drv.id);
        reoptDriverConstraints.push({
          vehicleId: drv.vehicleId,
          driverName: drv.name,
          preferredStartTime: p?.preferredStartTime ?? "07:00:00",
          preferredEndTime: p?.preferredEndTime ?? "16:00:00",
          maxDrivingHoursPerDay: p?.maxDrivingHoursPerDay ?? 8,
          avoidNightDriving: p?.avoidNightDriving ?? false,
          breakFrequencyMinutes: p?.breakFrequencyMinutes ?? 120,
          preferredBreakDurationMin: p?.preferredBreakDurationMin ?? 15,
        });
      }
    }

    const result = reoptimizeAffectedRoutes(
      currentALNSRoutes,
      affectedVehicleIds,
      alnsVehicles,
      depLat,
      depLon,
      startTime,
      { timeLimitMs: 15000, driverConstraints: reoptDriverConstraints }
    );

    for (const stop of pendingStops) {
      await db
        .update(stopsTable)
        .set({ routeId: null, sequenceOrder: null })
        .where(and(eq(stopsTable.id, stop.id), eq(stopsTable.organizationId, organizationId)));
    }

    const reoptimizedRoutes = [];

    const affectedResultRoutes = result.routes.filter(r =>
      affectedVehicleIds.includes(r.vehicleId)
    );

    for (const alnsRoute of affectedResultRoutes) {
      if (alnsRoute.nodes.length === 0) continue;

      const vehicle = allOrgVehicles.find(v => v.id === alnsRoute.vehicleId);
      if (!vehicle) continue;

      const existingRoute = affectedRoutes.find(r => r.vehicleId === vehicle.id);
      const routeId = existingRoute?.id;
      if (!routeId) continue;

      let seqOrder = 0;
      let prevLat = depLat;
      let prevLon = depLon;
      let currentTime = new Date();
      let routeDistance = 0;
      let routeDuration = 0;

      const optimizedStops: Array<{
        stopId: string;
        sequenceOrder: number;
        estimatedArrival: string;
        distanceFromPreviousKm: number;
        isChargingStop?: boolean;
        chargingStationName?: string;
      }> = [];

      for (const node of alnsRoute.nodes) {
        const dist = cachedDistance(prevLat, prevLon, node.latitude, node.longitude);
        const dur = estimateDurationMin(dist, currentTime);
        routeDistance += dist;
        const arrivalTime = new Date(currentTime.getTime() + dur * 60000);
        seqOrder++;

        if (node.isChargingStation) {
          const chargeDur = node.chargingDurationMin ?? 30;
          routeDuration += dur + chargeDur;
          optimizedStops.push({
            stopId: node.id,
            sequenceOrder: seqOrder,
            estimatedArrival: arrivalTime.toISOString(),
            distanceFromPreviousKm: Math.round(dist * 100) / 100,
            isChargingStop: true,
            chargingStationName: node.chargingStationName,
          });
          currentTime = new Date(arrivalTime.getTime() + chargeDur * 60000);
        } else {
          routeDuration += dur + node.serviceDurationMin;
          const effectiveStart = node.timeWindowStart && node.timeWindowStart.getTime() > arrivalTime.getTime()
            ? node.timeWindowStart
            : arrivalTime;

          const trackingCode = await generateUniqueTrackingCode();
          await db
            .update(stopsTable)
            .set({ routeId, sequenceOrder: seqOrder, trackingCode })
            .where(and(eq(stopsTable.id, node.id), eq(stopsTable.organizationId, organizationId)));

          optimizedStops.push({
            stopId: node.id,
            sequenceOrder: seqOrder,
            estimatedArrival: effectiveStart.toISOString(),
            distanceFromPreviousKm: Math.round(dist * 100) / 100,
          });
          currentTime = new Date(effectiveStart.getTime() + node.serviceDurationMin * 60000);
        }

        prevLat = node.latitude;
        prevLon = node.longitude;
      }

      const co2 = estimateCo2(routeDistance, vehicle.vehicleType, alnsRoute.totalWeight, vehicle.capacityKg);

      await db
        .update(routesTable)
        .set({
          totalDistanceKm: Math.round(routeDistance * 100) / 100,
          totalDurationMin: Math.round(routeDuration * 100) / 100,
          co2EmissionsKg: Math.round(co2 * 100) / 100,
          totalStops: alnsRoute.nodes.filter(n => !n.isChargingStation).length,
          updatedAt: new Date(),
        })
        .where(eq(routesTable.id, routeId));

      reoptimizedRoutes.push({
        vehicleId: vehicle.id,
        routeId,
        stops: optimizedStops,
        distanceKm: Math.round(routeDistance * 100) / 100,
        durationMin: Math.round(routeDuration * 100) / 100,
        co2EmissionsKg: Math.round(co2 * 100) / 100,
      });
    }

    broadcast(organizationId, "routes:reoptimized", {
      routeIds: reoptimizedRoutes.map(r => r.routeId),
      reason: reason ?? disruptionType ?? "disruption",
    });

    await db.insert(notificationsTable).values({
      organizationId,
      type: "route_started",
      title: "Routes re-optimized",
      message: `${reoptimizedRoutes.length} route(s) re-optimized due to ${reason ?? disruptionType ?? "disruption"}`,
      relatedEntityId: reoptimizedRoutes[0]?.routeId ?? null,
    });

    res.json({
      reoptimizedRoutes,
      affectedRouteIds: affectedRouteIds,
      unassignedStopIds: result.unassigned.map(n => n.id),
      reason: reason ?? disruptionType ?? "disruption",
      optimizer: "alns-incremental",
    });
  } catch (err) {
    handleError(res, err);
  }
});

const ContinuousStartBody = z.object({
  organizationId: z.string().uuid(),
  routeIds: z.array(z.string().uuid()).optional(),
  depotLatitude: z.number().optional().default(59.3293),
  depotLongitude: z.number().optional().default(18.0686),
  microIterationMs: z.number().min(50).max(500).optional().default(100),
  maxIdleMinutes: z.number().min(1).max(60).optional().default(5),
});

router.post("/optimize/continuous/start", async (req, res) => {
  try {
    const parsed = ContinuousStartBody.parse(req.body);
    const { organizationId, routeIds, depotLatitude, depotLongitude, microIterationMs, maxIdleMinutes } = parsed;

    const existing = getActiveOptimizer(organizationId);
    if (existing?.isRunning()) {
      res.status(409).json({ error: "Continuous optimization already running for this organization" });
      return;
    }

    let targetRouteIds = routeIds;
    if (!targetRouteIds || targetRouteIds.length === 0) {
      const optimizedRoutes = await db
        .select()
        .from(routesTable)
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            eq(routesTable.status, "optimized")
          )
        );
      targetRouteIds = optimizedRoutes.map((r) => r.id);
    }

    if (targetRouteIds.length === 0) {
      res.status(400).json({ error: "No optimized routes found to improve" });
      return;
    }

    const routes = await db
      .select()
      .from(routesTable)
      .where(
        and(
          inArray(routesTable.id, targetRouteIds),
          eq(routesTable.organizationId, organizationId)
        )
      );

    const allStops: ALNSNode[] = [];
    for (const route of routes) {
      const routeStops = await db
        .select()
        .from(stopsTable)
        .where(
          and(eq(stopsTable.routeId, route.id), eq(stopsTable.organizationId, organizationId))
        );
      for (const s of routeStops) {
        if (s.status === "pending") {
          allStops.push({
            id: s.id,
            latitude: s.latitude,
            longitude: s.longitude,
            timeWindowStart: s.timeWindowStart,
            timeWindowEnd: s.timeWindowEnd,
            serviceDurationMin: s.serviceDurationMin,
            weightKg: Number(s.weightKg) || 0,
            volumeM3: Number(s.volumeM3) || 0,
          });
        }
      }
    }

    if (allStops.length === 0) {
      res.status(400).json({ error: "No pending stops found in the selected routes" });
      return;
    }

    const allVehicles = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.organizationId, organizationId));

    const alnsVehicles: ALNSVehicle[] = allVehicles.map((v) => ({
      id: v.id,
      vehicleType: v.vehicleType,
      capacityKg: v.capacityKg,
      capacityVolume: v.capacityVolume,
      rangeKm: v.rangeKm,
    }));

    const optimizer = new ContinuousOptimizer(
      organizationId,
      allStops,
      alnsVehicles,
      depotLatitude,
      depotLongitude,
      { microIterationMs, maxIdleMinutes }
    );

    optimizer.on("improvement", (event, status) => {
      broadcast(organizationId, "optimization:improvement", {
        iteration: event.iteration,
        cost: Math.round(event.cost * 100) / 100,
        previousCost: Math.round(event.previousCost * 100) / 100,
        deltaPercent: Math.round(event.deltaPercent * 100) / 100,
        totalImprovementPercent: Math.round(status.totalImprovementPercent * 100) / 100,
        costBreakdown: event.costBreakdown,
      });
    });

    optimizer.on("stopped", (status) => {
      broadcast(organizationId, "optimization:stopped", {
        totalImprovementPercent: Math.round(status.totalImprovementPercent * 100) / 100,
        iterations: status.iteration,
        bestCost: Math.round(status.bestCost * 100) / 100,
      });
    });

    optimizer.on("idle-timeout", (status) => {
      broadcast(organizationId, "optimization:stopped", {
        reason: "idle-timeout",
        totalImprovementPercent: Math.round(status.totalImprovementPercent * 100) / 100,
        iterations: status.iteration,
        bestCost: Math.round(status.bestCost * 100) / 100,
      });
      removeActiveOptimizer(organizationId);
    });

    optimizer.on("timeout", (status) => {
      broadcast(organizationId, "optimization:stopped", {
        reason: "max-time",
        totalImprovementPercent: Math.round(status.totalImprovementPercent * 100) / 100,
        iterations: status.iteration,
        bestCost: Math.round(status.bestCost * 100) / 100,
      });
      removeActiveOptimizer(organizationId);
    });

    setActiveOptimizer(organizationId, optimizer);
    await optimizer.start();

    res.json({
      message: "Continuous optimization started",
      status: optimizer.getStatus(),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/optimize/continuous/stop", async (req, res) => {
  try {
    const { organizationId } = z
      .object({ organizationId: z.string().uuid() })
      .parse(req.body);

    const optimizer = getActiveOptimizer(organizationId);
    if (!optimizer || !optimizer.isRunning()) {
      res.status(404).json({ error: "No active continuous optimization found" });
      return;
    }

    const bestSolution = optimizer.getSolution();
    optimizer.stop();
    const finalStatus = optimizer.getStatus();
    removeActiveOptimizer(organizationId);

    res.json({
      message: "Continuous optimization stopped",
      status: finalStatus,
      bestSolution: bestSolution
        ? {
            routes: bestSolution.routes.map((r) => ({
              vehicleId: r.vehicleId,
              nodeCount: r.nodes.filter((n) => !n.isChargingStation).length,
              totalWeight: r.totalWeight,
              totalVolume: r.totalVolume,
            })),
            unassignedCount: bestSolution.unassigned.length,
            cost: bestSolution.cost,
            costBreakdown: bestSolution.costBreakdown,
          }
        : null,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/optimize/continuous/status", async (req, res) => {
  try {
    const organizationId = z.string().uuid().parse(req.query.organizationId);

    const optimizer = getActiveOptimizer(organizationId);
    if (!optimizer) {
      res.json({ running: false, organizationId });
      return;
    }

    res.json(optimizer.getStatus());
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
