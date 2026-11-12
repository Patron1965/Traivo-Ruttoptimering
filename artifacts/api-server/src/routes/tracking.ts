import { Router, type IRouter } from "express";
import { eq, and, desc, gte, lte, asc, inArray, sql, or } from "drizzle-orm";
import {
  db,
  stopsTable,
  routesTable,
  vehiclesTable,
  driversTable,
  geofenceEventsTable,
  vehiclePositionsTable,
  routeExecutionsTable,
} from "@workspace/db";
import { handleError } from "../lib/errors";
import { persistPosition, getRealPosition, getLatestPositionEvidence } from "../services/real-positions";
import { assertOrgScope } from "../middleware/auth";
import { DriverAssistanceError, getDriverAssistanceContext } from "../lib/driver-assistance";
import { outgoingRoute, outgoingRoutesForDriver, outgoingStops } from "../services/outgoing-route-service";

const router: IRouter = Router();

const DEPOT_LAT = 59.3293;
const DEPOT_LON = 18.0686;
const AVG_SPEED_KMH = 35;

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

router.post("/tracking/location", async (req, res) => {
  try {
    // An administrator may assist execution actions, never contribute phone GPS
    // samples to the driver's vehicle/session.
    if (getDriverAssistanceContext(req)) {
      res.status(403).json({ error: "Driver assistance cannot submit driver telemetry" });
      return;
    }
    const {
      vehicleId,
      latitude,
      longitude,
      heading,
      speedKmh,
      accuracy,
      organizationId: requestedOrganizationId,
      routeId,
      clientSessionId,
      timestamp,
    } = req.body;
    if (!vehicleId || latitude == null || longitude == null) {
      res.status(400).json({ error: "vehicleId, latitude, longitude required" });
      return;
    }
    if (typeof routeId !== "string" || !routeId.trim()) {
      res.status(400).json({
        error: "routeId is required for every GPS sample",
        code: "ROUTE_ID_REQUIRED",
      });
      return;
    }
    if (typeof clientSessionId !== "string" || !clientSessionId.trim()) {
      res.status(400).json({
        error: "clientSessionId is required for every GPS sample",
        code: "CLIENT_SESSION_ID_REQUIRED",
      });
      return;
    }

    const orgId = assertOrgScope(req, requestedOrganizationId);
    const positionTimestamp = timestamp == null ? Date.now() : Number(timestamp);
    if (!Number.isFinite(positionTimestamp)) {
      res.status(400).json({ error: "timestamp must be a valid epoch millisecond value" });
      return;
    }
    const now = Date.now();
    if (positionTimestamp > now + 5 * 60_000) {
      res.status(400).json({ error: "timestamp cannot be more than five minutes in the future" });
      return;
    }
    if (now - positionTimestamp > 2 * 60_000) {
      res.status(409).json({
        error: "GPS position is stale; discard it and send a fresh fix",
        code: "STALE_POSITION",
      });
      return;
    }
    const [vehicle] = await db
      .select()
      .from(vehiclesTable)
      .where(and(eq(vehiclesTable.id, vehicleId), eq(vehiclesTable.organizationId, orgId)))
      .limit(1);
    if (!vehicle) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    if (req.user!.role === "driver") {
      if (!req.user!.driverProfileId) {
        res.status(403).json({ error: "Forbidden: driver account has no linked driver profile" });
        return;
      }
      const [driver] = await db
        .select({ id: driversTable.id })
        .from(driversTable)
        .where(and(
          eq(driversTable.id, req.user!.driverProfileId),
          eq(driversTable.organizationId, orgId),
          eq(driversTable.isActive, true),
        ))
        .limit(1);
      if (!driver) {
        res.status(403).json({ error: "Forbidden: drivers may only track their assigned vehicle" });
        return;
      }
    }

    // Route authorization and position persistence must be one serialized
    // operation. Route removal owns this same advisory/row lock, so a GPS
    // sample validated before cancellation cannot be persisted afterward.
    const trackingResult = await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`);
      let [route] = await tx
        .select()
        .from(routesTable)
        .where(and(
          eq(routesTable.id, routeId),
          eq(routesTable.organizationId, orgId),
        ))
        .limit(1)
        .for("update");
      if (!route) return { kind: "forbidden" as const, error: "Forbidden: route does not belong to this vehicle and organization" };
      if (route.dispatchSnapshotVersion != null || req.user!.role === "driver") route = await outgoingRoute(route, tx);
      if (route.vehicleId !== vehicleId) return { kind: "forbidden" as const, error: "Vehicle does not match the exact outgoing snapshot" };
      if (
        !route.handoffDriverId
        || route.handoffStatus !== "accepted"
        || route.handoffVersion !== route.planRevision
        || (req.user!.role === "driver" && route.handoffDriverId !== req.user!.driverProfileId)
      ) {
        return { kind: "forbidden" as const, error: "Forbidden: route handoff must be accepted for the current plan before tracking" };
      }
      const executionConditions = [
        eq(routeExecutionsTable.organizationId, orgId),
        eq(routeExecutionsTable.routeId, route.id),
        eq(routeExecutionsTable.planVersion, route.planRevision),
        eq(routeExecutionsTable.status, "active" as const),
        eq(routeExecutionsTable.driverId, route.handoffDriverId),
        ...(req.user!.role === "driver" && req.user!.driverProfileId
          ? [eq(routeExecutionsTable.driverId, req.user!.driverProfileId)]
          : []),
      ];
      const [execution] = await tx
        .select({ id: routeExecutionsTable.id, startClientEventId: routeExecutionsTable.startClientEventId })
        .from(routeExecutionsTable)
        .where(and(...executionConditions))
        .limit(1)
        .for("update");
      if (!execution) {
        const [endedExecution] = await tx
          .select({ id: routeExecutionsTable.id })
          .from(routeExecutionsTable)
          .where(and(
            eq(routeExecutionsTable.organizationId, orgId),
            eq(routeExecutionsTable.routeId, route.id),
            eq(routeExecutionsTable.planVersion, route.planRevision),
            eq(routeExecutionsTable.status, "ended" as const),
            eq(routeExecutionsTable.driverId, route.handoffDriverId),
          ))
          .limit(1);
        return endedExecution
          ? { kind: "ended" as const }
          : { kind: "unstarted" as const };
      }
      if (execution.startClientEventId !== clientSessionId.trim()) return { kind: "session_mismatch" as const };
      const accepted = await persistPosition(
        vehicleId,
        {
          latitude: Number(latitude),
          longitude: Number(longitude),
          heading: Number(heading ?? 0),
          speedKmh: Number(speedKmh ?? 0),
          timestamp: positionTimestamp,
        },
        {
          organizationId: orgId,
          routeId: route.id,
          executionId: execution.id,
          startClientEventId: execution.startClientEventId,
          accuracy: accuracy != null ? Number(accuracy) : null,
        },
        tx,
      );
      return { kind: accepted ? "accepted" as const : "stale" as const };
    });
    if (trackingResult.kind === "forbidden") {
      res.status(403).json({ error: trackingResult.error });
      return;
    }
    if (trackingResult.kind === "ended") {
      res.status(409).json({
        error: "Route execution has ended; GPS fixes are no longer accepted for this route",
        code: "ROUTE_EXECUTION_ENDED",
      });
      return;
    }
    if (trackingResult.kind === "unstarted") {
      res.status(409).json({
        error: "Route session has not been started; start the route before sending GPS",
        code: "ROUTE_SESSION_NOT_STARTED",
      });
      return;
    }
    if (trackingResult.kind === "session_mismatch") {
      res.status(409).json({
        error: "clientSessionId does not match the active route execution",
        code: "ROUTE_SESSION_MISMATCH",
      });
      return;
    }
    if (trackingResult.kind === "stale") {
      res.status(409).json({
        error: "GPS position is older than the latest accepted fix",
        code: "STALE_POSITION",
      });
      return;
    }
    res.json({ ok: true });
  } catch (err) {
    if (err instanceof DriverAssistanceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

router.get("/tracking/history/vehicle/:vehicleId", async (req, res) => {
  try {
    if (req.user!.role !== "admin" && req.user!.role !== "dispatcher") {
      res.status(403).json({ error: "Historical tracking is restricted to planning roles" });
      return;
    }
    const { vehicleId } = req.params;
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId required" });
      return;
    }
    const [vehicle] = await db
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(and(eq(vehiclesTable.id, vehicleId), eq(vehiclesTable.organizationId, organizationId)))
      .limit(1);
    if (!vehicle) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    const fromIso = req.query.from as string | undefined;
    const toIso = req.query.to as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 1000, 5000);

    const conditions = [
      eq(vehiclePositionsTable.organizationId, organizationId),
      eq(vehiclePositionsTable.vehicleId, vehicleId),
    ];
    if (fromIso) conditions.push(gte(vehiclePositionsTable.recordedAt, new Date(fromIso)));
    if (toIso) conditions.push(lte(vehiclePositionsTable.recordedAt, new Date(toIso)));

    const positions = await db
      .select({
        latitude: vehiclePositionsTable.latitude,
        longitude: vehiclePositionsTable.longitude,
        heading: vehiclePositionsTable.heading,
        speedKmh: vehiclePositionsTable.speedKmh,
        recordedAt: vehiclePositionsTable.recordedAt,
        routeId: vehiclePositionsTable.routeId,
      })
      .from(vehiclePositionsTable)
      .where(and(...conditions))
      .orderBy(asc(vehiclePositionsTable.recordedAt))
      .limit(limit);

    res.json(positions);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/tracking/history/route/:routeId", async (req, res) => {
  try {
    if (req.user!.role !== "admin" && req.user!.role !== "dispatcher") {
      res.status(403).json({ error: "Historical tracking is restricted to planning roles" });
      return;
    }
    const { routeId } = req.params;
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId required" });
      return;
    }
    const [route] = await db
      .select({ id: routesTable.id })
      .from(routesTable)
      .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)))
      .limit(1);
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    const positions = await db
      .select({
        latitude: vehiclePositionsTable.latitude,
        longitude: vehiclePositionsTable.longitude,
        heading: vehiclePositionsTable.heading,
        speedKmh: vehiclePositionsTable.speedKmh,
        recordedAt: vehiclePositionsTable.recordedAt,
      })
      .from(vehiclePositionsTable)
      .where(
        and(
          eq(vehiclePositionsTable.organizationId, organizationId),
          eq(vehiclePositionsTable.routeId, routeId),
        ),
      )
      .orderBy(asc(vehiclePositionsTable.recordedAt))
      .limit(5000);
    res.json(positions);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/vehicles/positions", async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    // Drivers are execution recipients, not planners. Their live view must be
    // limited to an accepted current-plan route handed to their own profile,
    // on their currently assigned vehicle, with fresh execution telemetry.
    let driverVehicleId: string | null = null;
    let driverProfileId: string | null = null;
    if (req.user!.role === "driver") {
      driverProfileId = req.user!.driverProfileId;
      if (!driverProfileId) {
        res.json([]);
        return;
      }
      const [driver] = await db
        .select({ vehicleId: driversTable.vehicleId })
        .from(driversTable)
        .where(and(
          eq(driversTable.id, driverProfileId),
          eq(driversTable.organizationId, organizationId),
          eq(driversTable.isActive, true),
        ))
        .limit(1);
      driverVehicleId = driver?.vehicleId ?? null;
      if (!driver) {
        res.json([]);
        return;
      }
    }

    const driverRouteScope = driverProfileId
      ? [
        eq(routesTable.handoffDriverId, driverProfileId),
        eq(routesTable.handoffStatus, "accepted" as const),
      ]
      : [];
    const routeScope = [
      eq(routesTable.organizationId, organizationId),
      ...(req.user!.role === "driver" ? driverRouteScope : []),
    ];
    let activeRoutes = await db
      .select()
      .from(routesTable)
      .where(and(...routeScope, or(eq(routesTable.status, "in_progress"), eq(routesTable.handoffStatus, "accepted"))));
    // Match planner outgoing scope: a withdrawn/cleared handoff is not a
    // current dispatch. Do not let its historical snapshot break every
    // other vehicle's position response, or resurrect it from that snapshot.
    activeRoutes = activeRoutes.filter((route) => !(
      route.handoffVersion == null && route.handoffDriverId == null
      && route.handoffStatus === "pending"
    ));
    activeRoutes = await Promise.all(activeRoutes.map((route) => route.dispatchSnapshotVersion != null ? outgoingRoute(route) : route));
    if (req.user!.role === "driver" && driverProfileId) {
      activeRoutes = (await outgoingRoutesForDriver(organizationId, driverProfileId))
        .filter((route) => route.handoffStatus === "accepted" && route.status === "in_progress");
    }
    if (req.user!.role !== "driver" && activeRoutes.length === 0) {
      activeRoutes = await db
        .select()
        .from(routesTable)
        .where(and(...routeScope, eq(routesTable.status, "optimized")));
    }

    const positions = [];
    for (const route of activeRoutes) {
      if (!route.vehicleId) continue;

      const [liveVehicle] = await db
        .select()
        .from(vehiclesTable)
        .where(and(
          eq(vehiclesTable.id, route.vehicleId),
          eq(vehiclesTable.organizationId, organizationId),
        ))
        .limit(1);
      if (!liveVehicle) continue;
      const approvedVehicle = (route as unknown as { __vehicle?: typeof liveVehicle }).__vehicle;
      const vehicle = { ...(approvedVehicle ?? liveVehicle), currentBatteryPercent: liveVehicle.currentBatteryPercent };

      let stops = await db
        .select()
        .from(stopsTable)
        .where(and(
          eq(stopsTable.routeId, route.id),
          eq(stopsTable.organizationId, organizationId),
        ))
        .orderBy(stopsTable.sequenceOrder);
      if (route.dispatchSnapshotVersion != null) stops = await outgoingStops(route);

      if (stops.length === 0) continue;

      const realPos = await getLatestPositionEvidence(organizationId, vehicle.id);
      // Only execution telemetry may identify an in-progress vehicle's
      // position. Never turn planned route geometry or elapsed wall time into
      // fabricated movement, and never present it as GPS.
      if (!realPos && (req.user!.role === "driver" || route.status !== "optimized")) continue;

      const plannedMarker = route.depotSnapshot?.start ?? {
        latitude: DEPOT_LAT,
        longitude: DEPOT_LON,
      };
      const pos = realPos
        ? {
          latitude: realPos.latitude,
          longitude: realPos.longitude,
          heading: realPos.heading,
        }
        : {
          latitude: plannedMarker.latitude,
          longitude: plannedMarker.longitude,
          heading: 0,
        };
      const currentSpeed = realPos?.speedKmh ?? 0;

      let nextStopIdx = -1;
      let etaMin: number | null = null;
      for (let i = 0; i < stops.length; i++) {
        if (stops[i].status === "pending" || stops[i].status === "in_progress") {
          nextStopIdx = i;
          if (realPos) {
            const distToNextStop = haversineDistance(
              pos.latitude,
              pos.longitude,
              stops[i].latitude,
              stops[i].longitude,
            );
            const effectiveSpeed = currentSpeed > 0 ? currentSpeed : AVG_SPEED_KMH;
            etaMin = Math.round((distToNextStop / effectiveSpeed) * 60);
          }
          break;
        }
      }

      if (route.executionProjection?.selectionChangedAt && nextStopIdx >= 0) {
        const { driverArrivals } = await import("../services/driver-arrival");
        const arrivals = await driverArrivals(route.id, organizationId, stops);
        const estimatedAt = arrivals[stops[nextStopIdx].id]?.estimatedAt;
        etaMin = estimatedAt ? Math.max(0, Math.round((Date.parse(estimatedAt) - Date.now()) / 60000)) : null;
      }
      positions.push({
        vehicleId: vehicle.id,
        vehicleName: vehicle.name,
        vehicleType: vehicle.vehicleType,
        licensePlate: vehicle.licensePlate,
        latitude: pos.latitude,
        longitude: pos.longitude,
        heading: pos.heading,
        speedKmh: currentSpeed,
        routeId: route.id,
        routeName: route.name,
        nextStopAddress: nextStopIdx >= 0 ? stops[nextStopIdx].address : null,
        etaMinutes: etaMin,
        batteryPercent: vehicle.currentBatteryPercent,
        distanceTravelledKm: 0,
        isRealGps: !!realPos,
        measuredAt: realPos ? new Date(realPos.timestamp).toISOString() : null,
      });
    }

    res.json(req.user!.role === "viewer"
      ? positions.map((position) => ({
        ...position,
        nextStopAddress: null,
        etaMinutes: null,
      }))
      : positions);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/geofence/events", async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const eventScope = [eq(geofenceEventsTable.organizationId, organizationId)];
    let redactStopAddress = false;
    if (req.user!.role === "driver") {
      const driverProfileId = req.user!.driverProfileId;
      if (!driverProfileId) {
        res.json([]);
        return;
      }
      const [driver] = await db
        .select({ vehicleId: driversTable.vehicleId })
        .from(driversTable)
        .where(and(
          eq(driversTable.id, driverProfileId),
          eq(driversTable.organizationId, organizationId),
          eq(driversTable.isActive, true),
        ))
        .limit(1);
      if (!driver) {
        res.json([]);
        return;
      }
      const authorizedRoutes = await db
        .select({ id: routesTable.id })
        .from(routesTable)
        .where(and(
          eq(routesTable.organizationId, organizationId),
          eq(routesTable.handoffDriverId, driverProfileId),
          eq(routesTable.handoffStatus, "accepted"),
        ));
      if (authorizedRoutes.length === 0) {
        res.json([]);
        return;
      }
      eventScope.push(inArray(
        geofenceEventsTable.routeId,
        authorizedRoutes.map((route) => route.id),
      ));
    } else if (req.user!.role === "viewer") {
      // Viewers retain the operational activity feed, but customer addresses
      // are not part of their read projection.
      redactStopAddress = true;
    }
    const events = await db
      .select()
      .from(geofenceEventsTable)
      .where(and(...eventScope))
      .orderBy(desc(geofenceEventsTable.timestamp))
      .limit(limit);
    res.json(redactStopAddress
      ? events.map((event) => ({ ...event, stopAddress: null }))
      : events);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
