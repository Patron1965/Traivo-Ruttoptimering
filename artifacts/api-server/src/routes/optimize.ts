import { Router, type IRouter } from "express";
import { eq, and, inArray } from "drizzle-orm";
import { db, vehiclesTable, stopsTable, routesTable, notificationsTable } from "@workspace/db";
import { OptimizeRoutesBody } from "@workspace/api-zod";
import { handleError } from "../lib/errors";
import crypto from "crypto";

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

interface CWRoute {
  stops: StopData[];
  vehicleId: string | null;
  totalWeight: number;
  totalVolume: number;
}

function computeRouteDistance(stops: StopData[], depotLat: number, depotLon: number): number {
  let dist = 0;
  let prevLat = depotLat;
  let prevLon = depotLon;
  for (const s of stops) {
    dist += haversineDistance(prevLat, prevLon, s.latitude, s.longitude);
    prevLat = s.latitude;
    prevLon = s.longitude;
  }
  dist += haversineDistance(prevLat, prevLon, depotLat, depotLon);
  return dist;
}

function simulateRouteSchedule(
  stops: StopData[],
  depotLat: number,
  depotLon: number,
  startTime: Date
): { feasible: boolean; endTime: Date } {
  let currentTime = new Date(startTime);
  let prevLat = depotLat;
  let prevLon = depotLon;
  for (const stop of stops) {
    const dist = haversineDistance(prevLat, prevLon, stop.latitude, stop.longitude);
    const travelMin = estimateDurationMin(dist);
    const arrival = new Date(currentTime.getTime() + travelMin * 60000);
    if (!isTimeWindowFeasible(stop, arrival)) {
      return { feasible: false, endTime: arrival };
    }
    const effectiveStart = stop.timeWindowStart && stop.timeWindowStart.getTime() > arrival.getTime()
      ? stop.timeWindowStart
      : arrival;
    currentTime = new Date(effectiveStart.getTime() + stop.serviceDurationMin * 60000);
    prevLat = stop.latitude;
    prevLon = stop.longitude;
  }
  return { feasible: true, endTime: currentTime };
}

function clarkeWrightSavingsAssignment(
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

  if (stops.length === 0) {
    return { assigned, unassigned: [] as StopData[] };
  }

  const cwRoutes: CWRoute[] = stops.map((s) => ({
    stops: [s],
    vehicleId: null,
    totalWeight: s.weightKg ?? 0,
    totalVolume: s.volumeM3 ?? 0,
  }));

  const stopToRoute = new Map<string, number>();
  for (let i = 0; i < stops.length; i++) {
    stopToRoute.set(stops[i].id, i);
  }

  const distFromDepot = new Map<string, number>();
  for (const s of stops) {
    distFromDepot.set(s.id, haversineDistance(depotLat, depotLon, s.latitude, s.longitude));
  }

  interface Saving {
    i: number;
    j: number;
    value: number;
  }
  const savings: Saving[] = [];
  for (let i = 0; i < stops.length; i++) {
    for (let j = i + 1; j < stops.length; j++) {
      const dDepotI = distFromDepot.get(stops[i].id)!;
      const dDepotJ = distFromDepot.get(stops[j].id)!;
      const dIJ = haversineDistance(stops[i].latitude, stops[i].longitude, stops[j].latitude, stops[j].longitude);
      const saving = dDepotI + dDepotJ - dIJ;
      if (saving > 0) {
        savings.push({ i, j, value: saving });
      }
    }
  }
  savings.sort((a, b) => b.value - a.value);

  const sortedVehicles = [...vehicles].sort((a, b) => b.capacityKg - a.capacityKg);

  function canFitVehicle(route: CWRoute, v: VehicleData): boolean {
    if (route.totalWeight > v.capacityKg || route.totalVolume > v.capacityVolume) {
      return false;
    }
    if (v.rangeKm) {
      const routeDist = computeRouteDistance(route.stops, depotLat, depotLon);
      if (routeDist > v.rangeKm * 1.5) {
        return false;
      }
    }
    return true;
  }

  function anyVehicleFits(route: CWRoute): boolean {
    for (const v of vehicles) {
      if (canFitVehicle(route, v)) return true;
    }
    return false;
  }

  for (const saving of savings) {
    const routeIdxI = stopToRoute.get(stops[saving.i].id)!;
    const routeIdxJ = stopToRoute.get(stops[saving.j].id)!;

    if (routeIdxI === routeIdxJ) continue;

    const routeI = cwRoutes[routeIdxI];
    const routeJ = cwRoutes[routeIdxJ];

    if (routeI.stops.length === 0 || routeJ.stops.length === 0) continue;

    const lastOfI = routeI.stops[routeI.stops.length - 1];
    const firstOfJ = routeJ.stops[0];
    const firstOfI = routeI.stops[0];
    const lastOfJ = routeJ.stops[routeJ.stops.length - 1];

    const stopI = stops[saving.i];
    const stopJ = stops[saving.j];

    let mergedStops: StopData[] | null = null;

    if (lastOfI.id === stopI.id && firstOfJ.id === stopJ.id) {
      mergedStops = [...routeI.stops, ...routeJ.stops];
    } else if (lastOfJ.id === stopJ.id && firstOfI.id === stopI.id) {
      mergedStops = [...routeJ.stops, ...routeI.stops];
    } else if (lastOfI.id === stopJ.id && firstOfJ.id === stopI.id) {
      mergedStops = [...routeI.stops, ...routeJ.stops];
    } else if (lastOfJ.id === stopI.id && firstOfI.id === stopJ.id) {
      mergedStops = [...routeJ.stops, ...routeI.stops];
    } else if (lastOfI.id === stopI.id && lastOfJ.id === stopJ.id) {
      mergedStops = [...routeI.stops, ...[...routeJ.stops].reverse()];
    } else if (firstOfI.id === stopI.id && firstOfJ.id === stopJ.id) {
      mergedStops = [...[...routeI.stops].reverse(), ...routeJ.stops];
    } else if (lastOfI.id === stopJ.id && lastOfJ.id === stopI.id) {
      mergedStops = [...routeI.stops, ...[...routeJ.stops].reverse()];
    } else if (firstOfI.id === stopJ.id && firstOfJ.id === stopI.id) {
      mergedStops = [...[...routeI.stops].reverse(), ...routeJ.stops];
    }

    if (!mergedStops) continue;

    const mergedWeight = routeI.totalWeight + routeJ.totalWeight;
    const mergedVolume = routeI.totalVolume + routeJ.totalVolume;

    const candidateRoute: CWRoute = {
      stops: mergedStops,
      vehicleId: null,
      totalWeight: mergedWeight,
      totalVolume: mergedVolume,
    };

    if (!anyVehicleFits(candidateRoute)) continue;

    const { feasible } = simulateRouteSchedule(mergedStops, depotLat, depotLon, startTime);
    if (!feasible) continue;

    routeI.stops = mergedStops;
    routeI.totalWeight = mergedWeight;
    routeI.totalVolume = mergedVolume;

    routeJ.stops = [];
    routeJ.totalWeight = 0;
    routeJ.totalVolume = 0;

    for (const s of mergedStops) {
      stopToRoute.set(s.id, routeIdxI);
    }
  }

  const activeRoutes = cwRoutes.filter((r) => r.stops.length > 0);
  activeRoutes.sort((a, b) => b.stops.length - a.stops.length);

  const unassigned: StopData[] = [];
  const usedVehicles = new Set<string>();

  for (const route of activeRoutes) {
    let bestVehicle: VehicleData | null = null;

    for (const v of sortedVehicles) {
      if (usedVehicles.has(v.id)) continue;
      if (canFitVehicle(route, v)) {
        bestVehicle = v;
        break;
      }
    }

    if (!bestVehicle) {
      unassigned.push(...route.stops);
      continue;
    }

    usedVehicles.add(bestVehicle.id);

    const va = assigned.get(bestVehicle.id)!;
    va.stops = route.stops;
    va.totalWeight = route.totalWeight;
    va.totalVolume = route.totalVolume;

    let prevLat = depotLat;
    let prevLon = depotLon;
    let currentTime = new Date(startTime);
    let totalDist = 0;
    let rangeUsed = 0;

    for (let i = 0; i < route.stops.length; i++) {
      const stop = route.stops[i];
      const dist = haversineDistance(prevLat, prevLon, stop.latitude, stop.longitude);
      totalDist += dist;
      rangeUsed += dist;

      if (bestVehicle.rangeKm) {
        const returnDist = haversineDistance(stop.latitude, stop.longitude, depotLat, depotLon);
        if (rangeUsed + returnDist > bestVehicle.rangeKm * 0.9) {
          const station = findNearestChargingStation(prevLat, prevLon);
          const distToStation = haversineDistance(prevLat, prevLon, station.latitude, station.longitude);
          const distFromStation = haversineDistance(station.latitude, station.longitude, stop.latitude, stop.longitude);

          va.chargingStops.push({
            stationId: station.id,
            stationName: station.name,
            latitude: station.latitude,
            longitude: station.longitude,
            insertedAfterStopIndex: i,
          });

          totalDist += distToStation + distFromStation - dist;
          const travelToStationMin = estimateDurationMin(distToStation);
          currentTime = new Date(currentTime.getTime() + travelToStationMin * 60000 + CHARGING_DURATION_MIN * 60000);

          const travelFromStationMin = estimateDurationMin(distFromStation);
          const arrival = new Date(currentTime.getTime() + travelFromStationMin * 60000);
          if (!isTimeWindowFeasible(stop, arrival)) {
            va.chargingStops.pop();
            totalDist -= distToStation + distFromStation - dist;
          } else {
            const effectiveStart = stop.timeWindowStart && stop.timeWindowStart.getTime() > arrival.getTime()
              ? stop.timeWindowStart
              : arrival;
            currentTime = new Date(effectiveStart.getTime() + stop.serviceDurationMin * 60000);

            rangeUsed = distFromStation;
            prevLat = stop.latitude;
            prevLon = stop.longitude;
            continue;
          }
        }
      }

      const travelMin = estimateDurationMin(dist);
      const arrival = new Date(currentTime.getTime() + travelMin * 60000);
      const effectiveStart = stop.timeWindowStart && stop.timeWindowStart.getTime() > arrival.getTime()
        ? stop.timeWindowStart
        : arrival;
      currentTime = new Date(effectiveStart.getTime() + stop.serviceDurationMin * 60000);

      prevLat = stop.latitude;
      prevLon = stop.longitude;
    }

    va.totalDistanceKm = totalDist;
    va.rangeUsedKm = rangeUsed;
    va.currentTime = currentTime;
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

    const { assigned, unassigned } = clarkeWrightSavingsAssignment(
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
          const trackingCode1 = await generateUniqueTrackingCode();
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
          const trackingCode2 = await generateUniqueTrackingCode();
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
