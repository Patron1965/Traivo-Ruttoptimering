import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, vehiclesTable, stopsTable, routesTable, notificationsTable } from "@workspace/db";
import { OptimizeRoutesBody } from "@workspace/api-zod";
import { handleError } from "../lib/errors";
import crypto from "crypto";

function generateTrackingCode(): string {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  const random = crypto.randomBytes(4);
  let code = "RT-";
  for (let i = 0; i < 4; i++) {
    code += chars[random[i] % chars.length];
  }
  return code;
}

const CHARGING_STATIONS = [
  { id: "cs-1", name: "Ionity Stockholm North", latitude: 59.3850, longitude: 18.0200 },
  { id: "cs-2", name: "Recharge Solna", latitude: 59.3600, longitude: 18.0000 },
  { id: "cs-3", name: "Tesla SC Kista", latitude: 59.4050, longitude: 17.9450 },
  { id: "cs-4", name: "Vattenfall Södermalm", latitude: 59.3150, longitude: 18.0700 },
  { id: "cs-5", name: "Mer Hammarby", latitude: 59.3050, longitude: 18.1000 },
  { id: "cs-6", name: "Ionity Nacka", latitude: 59.3100, longitude: 18.1600 },
  { id: "cs-7", name: "Recharge Bromma", latitude: 59.3400, longitude: 17.9400 },
  { id: "cs-8", name: "E.ON Järfälla", latitude: 59.4300, longitude: 17.8700 },
  { id: "cs-9", name: "Fortum Lidingö", latitude: 59.3700, longitude: 18.1500 },
  { id: "cs-10", name: "ChargeNode Danderyd", latitude: 59.3950, longitude: 18.0600 },
];

const CHARGING_DURATION_MIN = 30;

interface ChargingStopInserted {
  stationId: string;
  stationName: string;
  latitude: number;
  longitude: number;
  insertedAfterStopIndex: number;
}

function findNearestChargingStation(lat: number, lon: number): typeof CHARGING_STATIONS[0] {
  let best = CHARGING_STATIONS[0];
  let bestDist = Infinity;
  for (const station of CHARGING_STATIONS) {
    const d = haversineDistance(lat, lon, station.latitude, station.longitude);
    if (d < bestDist) {
      bestDist = d;
      best = station;
    }
  }
  return best;
}

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
  chargingStops: ChargingStopInserted[];
  rangeUsedKm: number;
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
      chargingStops: [],
      rangeUsedKm: 0,
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
    const needsCharging = new Map<string, {
      station: typeof CHARGING_STATIONS[0];
      distToStation: number;
      distStationToStop: number;
      totalDetourKm: number;
    }>();

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
        const projectedRangeUsed = va.rangeUsedKm + travelDistKm;
        const returnDist = haversineDistance(stop.latitude, stop.longitude, depotLat, depotLon);
        if (projectedRangeUsed + returnDist > vehicle.rangeKm * 0.9) {
          const lastStop = va.stops[va.stops.length - 1];
          const fromLat = lastStop ? lastStop.latitude : depotLat;
          const fromLon = lastStop ? lastStop.longitude : depotLon;
          const station = findNearestChargingStation(fromLat, fromLon);
          const distToStation = haversineDistance(fromLat, fromLon, station.latitude, station.longitude);
          const distStationToStop = haversineDistance(station.latitude, station.longitude, stop.latitude, stop.longitude);
          const totalWithCharging = distToStation + distStationToStop;
          const returnAfterCharging = haversineDistance(stop.latitude, stop.longitude, depotLat, depotLon);

          if (totalWithCharging + returnAfterCharging > vehicle.rangeKm * 0.9) {
            continue;
          }

          const travelToStationMin = estimateDurationMin(distToStation);
          const travelFromStationMin = estimateDurationMin(distStationToStop);
          const chargedArrival = new Date(
            va.currentTime.getTime() +
            travelToStationMin * 60000 +
            CHARGING_DURATION_MIN * 60000 +
            travelFromStationMin * 60000
          );
          if (!isTimeWindowFeasible(stop, chargedArrival)) {
            continue;
          }

          needsCharging.set(vehicle.id, {
            station,
            distToStation,
            distStationToStop,
            totalDetourKm: totalWithCharging,
          });
        }
      }

      if (travelDistKm < bestDistance) {
        bestDistance = travelDistKm;
        bestVehicle = vehicle.id;
      }
    }

    if (bestVehicle) {
      const va = assigned.get(bestVehicle)!;
      const chargingInfo = needsCharging.get(bestVehicle);

      if (chargingInfo) {
        const travelToStationMin = estimateDurationMin(chargingInfo.distToStation);
        va.currentTime = new Date(va.currentTime.getTime() + travelToStationMin * 60000 + CHARGING_DURATION_MIN * 60000);
        va.totalDistanceKm += chargingInfo.totalDetourKm;
        va.rangeUsedKm = chargingInfo.distStationToStop;

        va.chargingStops.push({
          stationId: chargingInfo.station.id,
          stationName: chargingInfo.station.name,
          latitude: chargingInfo.station.latitude,
          longitude: chargingInfo.station.longitude,
          insertedAfterStopIndex: va.stops.length,
        });

        va.stops.push(stop);
        va.totalWeight += stop.weightKg ?? 0;
        va.totalVolume += stop.volumeM3 ?? 0;

        const travelToStopMin = estimateDurationMin(chargingInfo.distStationToStop);
        const arrivalAtStop = new Date(va.currentTime.getTime() + travelToStopMin * 60000);
        const effectiveStart = stop.timeWindowStart && stop.timeWindowStart.getTime() > arrivalAtStop.getTime()
          ? stop.timeWindowStart
          : arrivalAtStop;
        va.currentTime = new Date(effectiveStart.getTime() + stop.serviceDurationMin * 60000);
      } else {
        const { arrivalTime, travelDistKm } = computeArrivalTime(va, stop, depotLat, depotLon);
        va.stops.push(stop);
        va.totalWeight += stop.weightKg ?? 0;
        va.totalVolume += stop.volumeM3 ?? 0;
        va.totalDistanceKm += travelDistKm;
        va.rangeUsedKm += travelDistKm;

        const effectiveStart = stop.timeWindowStart && stop.timeWindowStart.getTime() > arrivalTime.getTime()
          ? stop.timeWindowStart
          : arrivalTime;
        va.currentTime = new Date(effectiveStart.getTime() + stop.serviceDurationMin * 60000);
      }
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

      const chargingByIndex = new Map<number, ChargingStopInserted>();
      for (const cs of va.chargingStops) {
        chargingByIndex.set(cs.insertedAfterStopIndex, cs);
      }

      for (let i = 0; i < va.stops.length; i++) {
        const chargingBefore = chargingByIndex.get(i);
        if (chargingBefore) {
          const prevLat = i === 0 ? depotLatitude : va.stops[i - 1].latitude;
          const prevLon = i === 0 ? depotLongitude : va.stops[i - 1].longitude;
          const distToStation = haversineDistance(prevLat, prevLon, chargingBefore.latitude, chargingBefore.longitude);
          const durToStation = estimateDurationMin(distToStation);

          routeDistance += distToStation;
          routeDuration += durToStation + CHARGING_DURATION_MIN;

          const stationArrival = new Date(currentTime.getTime() + durToStation * 60000);
          seqOrder++;
          optimizedStops.push({
            stopId: chargingBefore.stationId,
            sequenceOrder: seqOrder,
            estimatedArrival: stationArrival.toISOString(),
            distanceFromPreviousKm: Math.round(distToStation * 100) / 100,
            isChargingStop: true,
            chargingStationName: chargingBefore.stationName,
          });

          currentTime = new Date(stationArrival.getTime() + CHARGING_DURATION_MIN * 60000);

          const distFromStation = haversineDistance(chargingBefore.latitude, chargingBefore.longitude, va.stops[i].latitude, va.stops[i].longitude);
          const durFromStation = estimateDurationMin(distFromStation);
          routeDistance += distFromStation;
          routeDuration += durFromStation + va.stops[i].serviceDurationMin;

          const arrivalTime = new Date(currentTime.getTime() + durFromStation * 60000);
          const effectiveStart = va.stops[i].timeWindowStart && va.stops[i].timeWindowStart!.getTime() > arrivalTime.getTime()
            ? va.stops[i].timeWindowStart!
            : arrivalTime;

          seqOrder++;
          const trackingCode1 = generateTrackingCode();
          await db
            .update(stopsTable)
            .set({ routeId: route.id, sequenceOrder: seqOrder, trackingCode: trackingCode1 })
            .where(and(eq(stopsTable.id, va.stops[i].id), eq(stopsTable.organizationId, organizationId)));

          optimizedStops.push({
            stopId: va.stops[i].id,
            sequenceOrder: seqOrder,
            estimatedArrival: effectiveStart.toISOString(),
            distanceFromPreviousKm: Math.round(distFromStation * 100) / 100,
          });

          currentTime = new Date(effectiveStart.getTime() + va.stops[i].serviceDurationMin * 60000);
        } else {
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

          seqOrder++;
          const trackingCode2 = generateTrackingCode();
          await db
            .update(stopsTable)
            .set({ routeId: route.id, sequenceOrder: seqOrder, trackingCode: trackingCode2 })
            .where(and(eq(stopsTable.id, stop.id), eq(stopsTable.organizationId, organizationId)));

          optimizedStops.push({
            stopId: stop.id,
            sequenceOrder: seqOrder,
            estimatedArrival: effectiveStart.toISOString(),
            distanceFromPreviousKm: Math.round(dist * 100) / 100,
          });

          currentTime = new Date(effectiveStart.getTime() + stop.serviceDurationMin * 60000);
        }
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
        chargingStopsInserted: va.chargingStops.length,
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
