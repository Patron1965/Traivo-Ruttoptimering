import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, vehiclesTable, stopsTable, routesTable } from "@workspace/db";
import { OptimizeRoutesBody } from "@workspace/api-zod";
import { handleError } from "../lib/errors";

function haversineDistance(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number
): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function estimateDurationMin(distanceKm: number): number {
  const avgSpeedKmH = 35;
  return (distanceKm / avgSpeedKmH) * 60;
}

function estimateCo2(distanceKm: number, vehicleType: string): number {
  const emissionFactor = vehicleType === "electric" ? 0.02 : 0.21;
  return distanceKm * emissionFactor;
}

interface StopData {
  id: string;
  latitude: number;
  longitude: number;
  timeWindowStart: Date | null;
  timeWindowEnd: Date | null;
  serviceDurationMin: number;
  weightKg: number | null;
  volumeM3: number | null;
}

interface VehicleData {
  id: string;
  vehicleType: string;
  capacityKg: number;
  capacityVolume: number;
  rangeKm: number | null;
}

interface VehicleAssignment {
  stops: StopData[];
  totalWeight: number;
  totalVolume: number;
  currentTime: Date;
  totalDistanceKm: number;
}

function computeArrivalTime(
  assignment: VehicleAssignment,
  stop: StopData,
  depotLat: number,
  depotLon: number
): { arrivalTime: Date; travelDistKm: number } {
  const lastStop = assignment.stops[assignment.stops.length - 1];
  const fromLat = lastStop ? lastStop.latitude : depotLat;
  const fromLon = lastStop ? lastStop.longitude : depotLon;
  const dist = haversineDistance(fromLat, fromLon, stop.latitude, stop.longitude);
  const travelMinutes = estimateDurationMin(dist);
  const arrivalTime = new Date(assignment.currentTime.getTime() + travelMinutes * 60000);
  return { arrivalTime, travelDistKm: dist };
}

function isTimeWindowFeasible(stop: StopData, arrivalTime: Date): boolean {
  if (stop.timeWindowEnd && arrivalTime.getTime() > stop.timeWindowEnd.getTime()) {
    return false;
  }
  return true;
}

function nearestNeighborAssignment(
  stops: StopData[],
  vehicles: VehicleData[],
  depotLat: number,
  depotLon: number,
  startTime: Date
) {
  const assigned: Map<string, VehicleAssignment> = new Map();
  for (const v of vehicles) {
    assigned.set(v.id, {
      stops: [],
      totalWeight: 0,
      totalVolume: 0,
      currentTime: new Date(startTime),
      totalDistanceKm: 0,
    });
  }

  const unassigned: StopData[] = [];

  const sortedByTimeWindow = [...stops].sort((a, b) => {
    if (a.timeWindowStart && b.timeWindowStart) {
      return a.timeWindowStart.getTime() - b.timeWindowStart.getTime();
    }
    if (a.timeWindowStart) return -1;
    if (b.timeWindowStart) return 1;
    return 0;
  });

  for (const stop of sortedByTimeWindow) {
    let bestVehicle: string | null = null;
    let bestDistance = Infinity;

    for (const vehicle of vehicles) {
      const va = assigned.get(vehicle.id)!;
      const newWeight = va.totalWeight + (stop.weightKg ?? 0);
      const newVolume = va.totalVolume + (stop.volumeM3 ?? 0);

      if (newWeight > vehicle.capacityKg || newVolume > vehicle.capacityVolume) {
        continue;
      }

      const { arrivalTime, travelDistKm } = computeArrivalTime(va, stop, depotLat, depotLon);

      if (!isTimeWindowFeasible(stop, arrivalTime)) {
        continue;
      }

      if (vehicle.rangeKm) {
        const projectedTotalDist = va.totalDistanceKm + travelDistKm;
        const returnDist = haversineDistance(stop.latitude, stop.longitude, depotLat, depotLon);
        if (projectedTotalDist + returnDist > vehicle.rangeKm * 0.9) {
          continue;
        }
      }

      if (travelDistKm < bestDistance) {
        bestDistance = travelDistKm;
        bestVehicle = vehicle.id;
      }
    }

    if (bestVehicle) {
      const va = assigned.get(bestVehicle)!;
      const { arrivalTime, travelDistKm } = computeArrivalTime(va, stop, depotLat, depotLon);
      va.stops.push(stop);
      va.totalWeight += stop.weightKg ?? 0;
      va.totalVolume += stop.volumeM3 ?? 0;
      va.totalDistanceKm += travelDistKm;

      const effectiveStart = stop.timeWindowStart && stop.timeWindowStart.getTime() > arrivalTime.getTime()
        ? stop.timeWindowStart
        : arrivalTime;
      va.currentTime = new Date(effectiveStart.getTime() + stop.serviceDurationMin * 60000);
    } else {
      unassigned.push(stop);
    }
  }

  return { assigned, unassigned };
}

const router: IRouter = Router();

router.post("/optimize", async (req, res) => {
  try {
    const data = OptimizeRoutesBody.parse(req.body);
    const { organizationId, vehicleIds, stopIds, depotLatitude, depotLongitude } = data;

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

    const { assigned, unassigned } = nearestNeighborAssignment(
      stops,
      vehicles,
      depotLatitude,
      depotLongitude,
      new Date()
    );

    const optimizedRoutes = [];
    let totalDistanceKm = 0;
    let totalDurationMin = 0;

    for (const vehicle of vehicles) {
      const va = assigned.get(vehicle.id)!;
      if (va.stops.length === 0) continue;

      const [route] = await db
        .insert(routesTable)
        .values({
          organizationId,
          vehicleId: vehicle.id,
          name: `${vehicle.name} - Optimized`,
          date: new Date(),
          status: "optimized",
          totalStops: va.stops.length,
        })
        .returning();

      let routeDistance = 0;
      let routeDuration = 0;
      const optimizedStops = [];
      let currentTime = new Date();

      for (let i = 0; i < va.stops.length; i++) {
        const stop = va.stops[i];
        const prevLat = i === 0 ? depotLatitude : va.stops[i - 1].latitude;
        const prevLon = i === 0 ? depotLongitude : va.stops[i - 1].longitude;
        const dist = haversineDistance(prevLat, prevLon, stop.latitude, stop.longitude);
        const dur = estimateDurationMin(dist);

        routeDistance += dist;
        routeDuration += dur + stop.serviceDurationMin;

        const arrivalTime = new Date(currentTime.getTime() + dur * 60000);

        const effectiveStart = stop.timeWindowStart && stop.timeWindowStart.getTime() > arrivalTime.getTime()
          ? stop.timeWindowStart
          : arrivalTime;

        await db
          .update(stopsTable)
          .set({
            routeId: route.id,
            sequenceOrder: i + 1,
          })
          .where(
            and(
              eq(stopsTable.id, stop.id),
              eq(stopsTable.organizationId, organizationId)
            )
          );

        optimizedStops.push({
          stopId: stop.id,
          sequenceOrder: i + 1,
          estimatedArrival: effectiveStart.toISOString(),
          distanceFromPreviousKm: Math.round(dist * 100) / 100,
        });

        currentTime = new Date(effectiveStart.getTime() + stop.serviceDurationMin * 60000);
      }

      const co2 = estimateCo2(routeDistance, vehicle.vehicleType);

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

      optimizedRoutes.push({
        vehicleId: vehicle.id,
        routeId: route.id,
        stops: optimizedStops,
        distanceKm: Math.round(routeDistance * 100) / 100,
        durationMin: Math.round(routeDuration * 100) / 100,
        co2EmissionsKg: Math.round(co2 * 100) / 100,
      });
    }

    res.json({
      routes: optimizedRoutes,
      totalDistanceKm: Math.round(totalDistanceKm * 100) / 100,
      totalDurationMin: Math.round(totalDurationMin * 100) / 100,
      unassignedStopIds: unassigned.map((s) => s.id),
    });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
