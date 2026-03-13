import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import {
  db,
  stopsTable,
  routesTable,
  vehiclesTable,
  geofenceEventsTable,
  notificationsTable,
} from "@workspace/db";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

const DEPOT_LAT = 59.3293;
const DEPOT_LON = 18.0686;
const AVG_SPEED_KMH = 35;
const GEOFENCE_RADIUS_KM = 0.5;

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

router.get("/vehicles/positions", async (req, res) => {
  try {
    const organizationId = req.query.organizationId as string;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    const activeRoutes = await db
      .select()
      .from(routesTable)
      .where(
        and(
          eq(routesTable.organizationId, organizationId),
          eq(routesTable.status, "in_progress")
        )
      );

    if (activeRoutes.length === 0) {
      const optimizedRoutes = await db
        .select()
        .from(routesTable)
        .where(
          and(
            eq(routesTable.organizationId, organizationId),
            eq(routesTable.status, "optimized")
          )
        );
      if (optimizedRoutes.length === 0) {
        res.json([]);
        return;
      }
      activeRoutes.push(...optimizedRoutes);
    }

    const positions = [];
    const now = Date.now();

    for (const route of activeRoutes) {
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
            await db
              .update(stopsTable)
              .set({ status: "in_progress" })
              .where(eq(stopsTable.id, stop.id));

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

            const allStopsForRoute = stops;
            const isFirstActive = allStopsForRoute.every(
              (s) => s.id === stop.id || s.status === "pending"
            );
            if (isFirstActive) {
              await db
                .update(routesTable)
                .set({ status: "in_progress", updatedAt: new Date() })
                .where(eq(routesTable.id, route.id));

              await db.insert(notificationsTable).values({
                organizationId,
                type: "route_started",
                title: `Route ${route.name} started`,
                message: `${vehicle.name} has started route ${route.name}`,
                relatedEntityId: route.id,
              });
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
            await db
              .update(stopsTable)
              .set({ status: "completed" })
              .where(eq(stopsTable.id, stop.id));

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

            const freshStops = await db
              .select()
              .from(stopsTable)
              .where(eq(stopsTable.routeId, route.id));
            const allDone = freshStops.every(
              (s) => s.status === "completed" || s.status === "failed" || s.status === "skipped"
            );
            if (allDone) {
              await db
                .update(routesTable)
                .set({ status: "completed", updatedAt: new Date() })
                .where(eq(routesTable.id, route.id));

              await db.insert(notificationsTable).values({
                organizationId,
                type: "route_completed",
                title: `Route ${route.name} completed`,
                message: `All deliveries on route ${route.name} have been completed`,
                relatedEntityId: route.id,
              });
            }
          }
        }
      }
    }

    res.json(positions);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/geofence/events", async (req, res) => {
  try {
    const organizationId = req.query.organizationId as string;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const events = await db
      .select()
      .from(geofenceEventsTable)
      .where(eq(geofenceEventsTable.organizationId, organizationId))
      .orderBy(desc(geofenceEventsTable.timestamp))
      .limit(limit);
    res.json(events);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
