import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "http";
import { eq, and, inArray } from "drizzle-orm";
import {
  db,
  stopsTable,
  routesTable,
  vehiclesTable,
  geofenceEventsTable,
  notificationsTable,
} from "@workspace/db";
import {
  reoptimizeAffectedRoutes,
  haversineDistance as alnsHaversine,
  cachedDistance,
  estimateCo2,
  type ALNSNode,
  type ALNSVehicle,
  type ALNSRoute,
} from "./services/alns";
import { getActiveOptimizer } from "./services/continuous-optimizer";

const DEPOT_LAT = 59.3293;
const DEPOT_LON = 18.0686;
const AVG_SPEED_KMH = 35;
const GEOFENCE_RADIUS_KM = 0.5;
import { getDefaultBoundsPredictions } from "./services/prediction";

const BROADCAST_INTERVAL_MS = 2000;

function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function interpolatePosition(
  fromLat: number, fromLon: number,
  toLat: number, toLon: number,
  fraction: number
): { latitude: number; longitude: number; heading: number } {
  const lat = fromLat + (toLat - fromLat) * fraction;
  const lon = fromLon + (toLon - fromLon) * fraction;
  const heading = Math.atan2(toLon - fromLon, toLat - fromLat) * (180 / Math.PI);
  return { latitude: lat, longitude: lon, heading: ((heading % 360) + 360) % 360 };
}

interface WsClient {
  ws: WebSocket;
  organizationId: string;
  subscribedPredictions?: boolean;
}

const clients: Set<WsClient> = new Set();
let broadcastTimer: ReturnType<typeof setInterval> | null = null;

async function computePositions(organizationId: string) {
  const activeRoutes = await db
    .select()
    .from(routesTable)
    .where(
      and(
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.status, "in_progress")
      )
    );

  const optimizedRoutes = await db
    .select()
    .from(routesTable)
    .where(
      and(
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.status, "optimized")
      )
    );

  const allRoutes = [...activeRoutes, ...optimizedRoutes];
  if (allRoutes.length === 0) return [];

  const positions = [];
  const now = Date.now();

  for (const route of allRoutes) {
    if (!route.vehicleId) continue;

    const [vehicle] = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, route.vehicleId));
    if (!vehicle) continue;

    const stops = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, route.id))
      .orderBy(stopsTable.sequenceOrder);

    if (stops.length === 0) continue;

    const waypoints = [
      { latitude: DEPOT_LAT, longitude: DEPOT_LON },
      ...stops.map((s) => ({ latitude: s.latitude, longitude: s.longitude })),
    ];

    let totalRouteDistKm = 0;
    const segmentDists: number[] = [];
    for (let i = 1; i < waypoints.length; i++) {
      const d = haversineDistance(
        waypoints[i - 1].latitude, waypoints[i - 1].longitude,
        waypoints[i].latitude, waypoints[i].longitude
      );
      segmentDists.push(d);
      totalRouteDistKm += d;
    }

    const totalTravelTimeSec = (totalRouteDistKm / AVG_SPEED_KMH) * 3600;
    const routeStartTime = route.createdAt.getTime();
    const elapsed = ((now - routeStartTime) / 1000) % (totalTravelTimeSec + 300);
    const fraction = Math.min(elapsed / totalTravelTimeSec, 1);
    const distanceTravelled = fraction * totalRouteDistKm;

    let cumDist = 0;
    let segIdx = 0;
    for (segIdx = 0; segIdx < segmentDists.length; segIdx++) {
      if (cumDist + segmentDists[segIdx] >= distanceTravelled) break;
      cumDist += segmentDists[segIdx];
    }

    if (segIdx >= segmentDists.length) segIdx = segmentDists.length - 1;

    const segFraction = segmentDists[segIdx] > 0
      ? (distanceTravelled - cumDist) / segmentDists[segIdx]
      : 0;

    const from = waypoints[segIdx];
    const to = waypoints[Math.min(segIdx + 1, waypoints.length - 1)];
    const pos = interpolatePosition(from.latitude, from.longitude, to.latitude, to.longitude, Math.min(segFraction, 1));

    let nextStopIdx = -1;
    let etaMin: number | null = null;
    for (let i = 0; i < stops.length; i++) {
      if (stops[i].status === "pending" || stops[i].status === "in_progress") {
        nextStopIdx = i;
        const distToNextStop = haversineDistance(pos.latitude, pos.longitude, stops[i].latitude, stops[i].longitude);
        etaMin = Math.round((distToNextStop / AVG_SPEED_KMH) * 60);
        break;
      }
    }

    positions.push({
      vehicleId: vehicle.id,
      vehicleName: vehicle.name,
      vehicleType: vehicle.vehicleType,
      licensePlate: vehicle.licensePlate,
      latitude: pos.latitude,
      longitude: pos.longitude,
      heading: pos.heading,
      speedKmh: fraction < 1 ? AVG_SPEED_KMH : 0,
      routeId: route.id,
      routeName: route.name,
      nextStopAddress: nextStopIdx >= 0 ? stops[nextStopIdx].address : null,
      etaMinutes: etaMin,
      batteryPercent: vehicle.currentBatteryPercent,
      distanceTravelledKm: Math.round(distanceTravelled * 100) / 100,
    });

    for (const stop of stops) {
      if (stop.status === "completed" || stop.status === "failed") continue;
      const distToStop = haversineDistance(pos.latitude, pos.longitude, stop.latitude, stop.longitude);

      if (distToStop <= GEOFENCE_RADIUS_KM && stop.status === "pending") {
        const existingEntry = await db
          .select()
          .from(geofenceEventsTable)
          .where(
            and(
              eq(geofenceEventsTable.stopId, stop.id),
              eq(geofenceEventsTable.vehicleId, vehicle.id),
              eq(geofenceEventsTable.eventType, "entered")
            )
          )
          .limit(1);

        if (existingEntry.length === 0) {
          await db.update(stopsTable).set({ status: "in_progress" }).where(eq(stopsTable.id, stop.id));

          await db.insert(geofenceEventsTable).values({
            organizationId,
            vehicleId: vehicle.id,
            stopId: stop.id,
            routeId: route.id,
            eventType: "entered",
            vehicleName: vehicle.name,
            stopAddress: stop.address,
          });

          await db.insert(notificationsTable).values({
            organizationId,
            type: "geofence_entry",
            title: `${vehicle.name} arriving`,
            message: `${vehicle.name} has arrived at ${stop.address}`,
            relatedEntityId: stop.id,
          });

          const isFirstActive = stops.every(
            (s) => s.id === stop.id || s.status === "pending"
          );
          if (isFirstActive) {
            await db.update(routesTable).set({ status: "in_progress", updatedAt: new Date() }).where(eq(routesTable.id, route.id));

            await db.insert(notificationsTable).values({
              organizationId,
              type: "route_started",
              title: `Route ${route.name} started`,
              message: `${vehicle.name} has started route ${route.name}`,
              relatedEntityId: route.id,
            });

            broadcast(organizationId, "route:status", { routeId: route.id, status: "in_progress" });
          }
        }
      } else if (distToStop > GEOFENCE_RADIUS_KM && stop.status === "in_progress") {
        const existingExit = await db
          .select()
          .from(geofenceEventsTable)
          .where(
            and(
              eq(geofenceEventsTable.stopId, stop.id),
              eq(geofenceEventsTable.vehicleId, vehicle.id),
              eq(geofenceEventsTable.eventType, "exited")
            )
          )
          .limit(1);

        if (existingExit.length === 0) {
          await db.update(stopsTable).set({ status: "completed" }).where(eq(stopsTable.id, stop.id));

          await db.insert(geofenceEventsTable).values({
            organizationId,
            vehicleId: vehicle.id,
            stopId: stop.id,
            routeId: route.id,
            eventType: "exited",
            vehicleName: vehicle.name,
            stopAddress: stop.address,
          });

          await db.insert(notificationsTable).values({
            organizationId,
            type: "geofence_exit",
            title: `${vehicle.name} departed`,
            message: `${vehicle.name} has departed from ${stop.address}`,
            relatedEntityId: stop.id,
          });

          await db.insert(notificationsTable).values({
            organizationId,
            type: "stop_completed",
            title: `Delivery completed`,
            message: `${vehicle.name} completed delivery at ${stop.address}`,
            relatedEntityId: stop.id,
          });

          broadcast(organizationId, "stop:completed", { stopId: stop.id, address: stop.address });

          const freshStops = await db
            .select()
            .from(stopsTable)
            .where(eq(stopsTable.routeId, route.id));
          const allDone = freshStops.every(
            (s) => s.status === "completed" || s.status === "failed" || s.status === "skipped"
          );
          if (allDone) {
            await db.update(routesTable).set({ status: "completed", updatedAt: new Date() }).where(eq(routesTable.id, route.id));

            await db.insert(notificationsTable).values({
              organizationId,
              type: "route_completed",
              title: `Route ${route.name} completed`,
              message: `All deliveries on route ${route.name} have been completed`,
              relatedEntityId: route.id,
            });

            broadcast(organizationId, "route:status", { routeId: route.id, status: "completed" });
          }
        }
      }
    }
  }

  return positions;
}

function broadcast(organizationId: string, type: string, payload: unknown) {
  const message = JSON.stringify({ type, data: payload, timestamp: Date.now() });
  for (const client of clients) {
    if (client.organizationId === organizationId && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

async function broadcastPositions() {
  const orgIds = new Set<string>();
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      orgIds.add(client.organizationId);
    }
  }

  for (const orgId of orgIds) {
    try {
      const positions = await computePositions(orgId);
      broadcast(orgId, "vehicles:positions", positions);
    } catch (err) {
      console.error(`WS broadcast error for org ${orgId}:`, err);
    }
  }
}

function broadcastPredictions() {
  const predictions = getDefaultBoundsPredictions();
  const message = JSON.stringify({ type: "predictions:update", data: predictions, timestamp: Date.now() });
  for (const client of clients) {
    if (client.subscribedPredictions && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  }
}

export function setupWebSocket(server: Server) {
  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    let client: WsClient | null = null;

    ws.on("message", (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe" && msg.organizationId) {
          client = { ws, organizationId: msg.organizationId };
          clients.add(client);
          ws.send(JSON.stringify({ type: "subscribed", organizationId: msg.organizationId }));
        } else if (msg.type === "subscribe-predictions" && client) {
          client.subscribedPredictions = true;
          ws.send(JSON.stringify({ type: "subscribed-predictions" }));
        } else if (msg.type === "disruption" && msg.disruptionType && client) {
          debouncedReoptimize({
            type: "disruption",
            disruptionType: msg.disruptionType,
            organizationId: client.organizationId,
            routeIds: msg.routeIds,
            affectedStopId: msg.affectedStopId,
            reason: msg.reason,
          });
          ws.send(JSON.stringify({ type: "disruption:ack", disruptionType: msg.disruptionType }));
        }
      } catch {}
    });

    ws.on("close", () => {
      if (client) clients.delete(client);
    });

    ws.on("error", () => {
      if (client) clients.delete(client);
    });
  });

  broadcastTimer = setInterval(broadcastPositions, BROADCAST_INTERVAL_MS);
  setInterval(broadcastPredictions, 30_000);

  console.log("WebSocket server ready on /ws");
  return wss;
}

interface DisruptionEvent {
  type: "disruption";
  disruptionType: "traffic_delay" | "vehicle_breakdown" | "stop_added" | "stop_cancelled";
  organizationId: string;
  routeIds?: string[];
  affectedStopId?: string;
  reason?: string;
}

const REOPT_DEBOUNCE_MS = 5000;
const pendingReoptimizations = new Map<string, ReturnType<typeof setTimeout>>();

async function handleDisruptionReoptimize(event: DisruptionEvent) {
  const { organizationId, disruptionType, routeIds, affectedStopId, reason } = event;

  const activeOptimizer = getActiveOptimizer(organizationId);
  if (activeOptimizer?.isRunning()) {
    if (disruptionType === "stop_added" && affectedStopId) {
      const [newStop] = await db.select().from(stopsTable).where(
        and(eq(stopsTable.id, affectedStopId), eq(stopsTable.organizationId, organizationId))
      );
      if (newStop) {
        activeOptimizer.injectDisruption([{
          id: newStop.id,
          latitude: newStop.latitude,
          longitude: newStop.longitude,
          timeWindowStart: newStop.timeWindowStart,
          timeWindowEnd: newStop.timeWindowEnd,
          serviceDurationMin: newStop.serviceDurationMin,
          weightKg: Number(newStop.weightKg) || 0,
          volumeM3: Number(newStop.volumeM3) || 0,
        }]);
      }
    } else if (disruptionType === "stop_cancelled" && affectedStopId) {
      activeOptimizer.injectDisruption([], [affectedStopId]);
    } else if (disruptionType === "traffic_delay" || disruptionType === "vehicle_breakdown") {
      activeOptimizer.injectDisruption([], []);
    }
    broadcast(organizationId, "optimization:disruption-injected", {
      disruptionType,
      affectedStopId: affectedStopId ?? null,
      reason: reason ?? disruptionType,
    });
    return;
  }

  let affectedRouteIds: string[] = routeIds ?? [];

  if (disruptionType === "stop_added" && affectedStopId) {
    const [newStop] = await db.select().from(stopsTable).where(
      and(eq(stopsTable.id, affectedStopId), eq(stopsTable.organizationId, organizationId))
    );
    if (!newStop) return;
    if (newStop.routeId) {
      affectedRouteIds = [newStop.routeId];
    } else {
      const activeRoutes = await db.select().from(routesTable).where(
        and(eq(routesTable.organizationId, organizationId), eq(routesTable.status, "optimized"))
      );
      if (activeRoutes.length === 0) return;
      const nearest = [];
      for (const route of activeRoutes) {
        const routeStops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, route.id));
        const minDist = Math.min(...routeStops.map(s =>
          alnsHaversine(newStop.latitude, newStop.longitude, s.latitude, s.longitude)
        ), Infinity);
        nearest.push({ route, minDist });
      }
      nearest.sort((a, b) => a.minDist - b.minDist);
      affectedRouteIds = nearest.slice(0, 2).map(r => r.route.id);
    }
  } else if (disruptionType === "stop_cancelled" && affectedStopId) {
    const [cancelledStop] = await db.select().from(stopsTable).where(
      and(eq(stopsTable.id, affectedStopId), eq(stopsTable.organizationId, organizationId))
    );
    if (cancelledStop?.routeId) {
      affectedRouteIds = [cancelledStop.routeId];
    } else {
      return;
    }
  }

  if (affectedRouteIds.length === 0) return;

  const affectedRoutes = await db.select().from(routesTable).where(
    and(inArray(routesTable.id, affectedRouteIds), eq(routesTable.organizationId, organizationId))
  );
  if (affectedRoutes.length === 0) return;

  const affectedVehicleIds = affectedRoutes.map(r => r.vehicleId).filter((id): id is string => id !== null);
  const allOrgVehicles = await db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));

  const allAffectedStops: (typeof stopsTable.$inferSelect)[] = [];
  for (const route of affectedRoutes) {
    const routeStops = await db.select().from(stopsTable).where(
      and(eq(stopsTable.routeId, route.id), eq(stopsTable.organizationId, organizationId))
    );
    allAffectedStops.push(...routeStops);
  }

  const pendingStops = allAffectedStops.filter(s => s.status === "pending");
  if (pendingStops.length === 0) return;

  const currentALNSRoutes: ALNSRoute[] = affectedRoutes.map(r => {
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

  const result = reoptimizeAffectedRoutes(
    currentALNSRoutes, affectedVehicleIds, alnsVehicles,
    DEPOT_LAT, DEPOT_LON, new Date(),
    { timeLimitMs: 10000 }
  );

  for (const stop of pendingStops) {
    await db.update(stopsTable).set({ routeId: null, sequenceOrder: null })
      .where(and(eq(stopsTable.id, stop.id), eq(stopsTable.organizationId, organizationId)));
  }

  const reoptimizedRouteIds: string[] = [];
  for (const alnsRoute of result.routes.filter(r => affectedVehicleIds.includes(r.vehicleId))) {
    if (alnsRoute.nodes.length === 0) continue;
    const vehicle = allOrgVehicles.find(v => v.id === alnsRoute.vehicleId);
    if (!vehicle) continue;
    const existingRoute = affectedRoutes.find(r => r.vehicleId === vehicle.id);
    if (!existingRoute) continue;

    let seqOrder = 0;
    let prevLat = DEPOT_LAT;
    let prevLon = DEPOT_LON;
    let routeDistance = 0;

    for (const node of alnsRoute.nodes) {
      const dist = cachedDistance(prevLat, prevLon, node.latitude, node.longitude);
      routeDistance += dist;
      seqOrder++;

      if (!node.isChargingStation) {
        await db.update(stopsTable)
          .set({ routeId: existingRoute.id, sequenceOrder: seqOrder })
          .where(and(eq(stopsTable.id, node.id), eq(stopsTable.organizationId, organizationId)));
      }
      prevLat = node.latitude;
      prevLon = node.longitude;
    }

    const co2 = estimateCo2(routeDistance, vehicle.vehicleType, alnsRoute.totalWeight, vehicle.capacityKg);
    await db.update(routesTable).set({
      totalDistanceKm: Math.round(routeDistance * 100) / 100,
      co2EmissionsKg: Math.round(co2 * 100) / 100,
      totalStops: alnsRoute.nodes.filter(n => !n.isChargingStation).length,
      updatedAt: new Date(),
    }).where(eq(routesTable.id, existingRoute.id));

    reoptimizedRouteIds.push(existingRoute.id);
  }

  if (reoptimizedRouteIds.length > 0) {
    broadcast(organizationId, "routes:reoptimized", {
      routeIds: reoptimizedRouteIds,
      reason: reason ?? disruptionType,
      triggeredBy: "ws-disruption",
    });

    await db.insert(notificationsTable).values({
      organizationId,
      type: "route_started",
      title: "Auto re-optimization triggered",
      message: `${reoptimizedRouteIds.length} route(s) re-optimized via real-time disruption: ${reason ?? disruptionType}`,
      relatedEntityId: reoptimizedRouteIds[0],
    });

    console.log(`[WS] Auto-reoptimized ${reoptimizedRouteIds.length} routes for org ${organizationId} due to ${disruptionType}`);
  }
}

function debouncedReoptimize(event: DisruptionEvent) {
  const key = `${event.organizationId}:${event.routeIds?.join(",") ?? event.affectedStopId ?? "all"}`;
  const existing = pendingReoptimizations.get(key);
  if (existing) clearTimeout(existing);

  pendingReoptimizations.set(key, setTimeout(async () => {
    pendingReoptimizations.delete(key);
    try {
      await handleDisruptionReoptimize(event);
    } catch (err) {
      console.error(`[WS] Auto-reoptimize failed for org ${event.organizationId}:`, err);
    }
  }, REOPT_DEBOUNCE_MS));
}

export { broadcast, debouncedReoptimize, type DisruptionEvent };
