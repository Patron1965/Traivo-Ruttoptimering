import { WebSocketServer, WebSocket, type RawData } from "ws";
import { publishRealtimeEvent, startRealtimeRelay } from "./services/realtime-relay";
import { logger } from "./lib/logger";
import type { Server } from "http";
import { resolveWorkspace } from "./lib/workspace-context";
import { eq, and, inArray, sql } from "drizzle-orm";
import { driverSessionUser } from "./lib/driver-device-policy";
import {
  db,
  usersTable,
  stopsTable,
  routesTable,
  vehiclesTable,
  driversTable,
  organizationsTable,
  notificationsTable,
} from "@workspace/db";
import {
  reoptimizeAffectedRoutes,
  haversineDistance as alnsHaversine,
  estimateCo2,
  type ALNSNode,
  type ALNSVehicle,
  type ALNSRoute,
} from "./services/alns";
import { getActiveOptimizer } from "./services/continuous-optimizer";
import { getRealPosition, getLatestPositionEvidence } from "./services/real-positions";
import { outgoingRoute, outgoingStops, outgoingStopContext } from "./services/outgoing-route-service";
import { getTerminalTimestampForStopStatus } from "./services/stop-service";
import { lockAndValidateReoptimizationSnapshot } from "./services/reoptimization-lock-service";
import { applyDriverRoutingProfile } from "./services/driver-routing-profile";
import {
  evaluateRouteWorkday,
  workdayInfeasibilityMessage,
} from "./services/route-workday";
import {
  itineraryForNodes,
  classifyUnplannedNodes,
  normalizePlanningInputs,
  refreshedPlanningSummary,
  routingConstraintsForDriver,
  verifiedDepotSnapshot,
} from "./services/import-route-workflow";
import {
  organizationPlanningPolicy,
  withOrganizationPlanningPolicy,
} from "./services/planning-policy";
import { payloadIdentityHash } from "./services/planning-draft-service";
import {
  onSessionRevoked,
  validateAndTouchSession,
  validateSessionWithoutTouch,
} from "./lib/session";
const DEPOT_LAT = 59.3293;
const DEPOT_LON = 18.0686;

export async function transitionGeofenceStopStatus(args: {
  organizationId: string;
  routeId: string;
  planVersion: number;
  stopId: string;
  expectedStatus: "pending" | "in_progress";
  nextStatus: "in_progress" | "completed";
}) {
  return db.transaction(async (tx) => {
    let [route] = await tx
      .select()
      .from(routesTable)
      .where(and(
        eq(routesTable.id, args.routeId),
        eq(routesTable.organizationId, args.organizationId),
      ))
      .limit(1)
      .for("update");
    if (route?.dispatchSnapshotVersion != null) route = await outgoingRoute(route, tx);
    if (
      !route
      || route.planRevision !== args.planVersion
      || route.handoffStatus !== "accepted"
      || route.handoffVersion !== route.planRevision
    ) {
      return null;
    }
    if (route.dispatchSnapshotVersion != null
      && !(await outgoingStops(route, tx)).some((stop) => stop.id === args.stopId)) return null;
    const [transitionedStop] = await tx.update(stopsTable).set({
      status: args.nextStatus,
      terminalAt: getTerminalTimestampForStopStatus(args.nextStatus),
    }).where(and(
      eq(stopsTable.id, args.stopId),
      eq(stopsTable.organizationId, args.organizationId),
      ...(route.dispatchSnapshotVersion != null ? [] : [eq(stopsTable.routeId, args.routeId)]),
      eq(stopsTable.status, args.expectedStatus),
    )).returning();
    if (
      transitionedStop
      && args.nextStatus === "completed"
      && route.lockedFirstStopId === args.stopId
    ) {
      // Geofence completion is a direct execution path; clear only the
      // route-owned first-stop constraint, preserving plan revision/handoff.
      await tx.update(routesTable).set({
        lockedFirstStopId: null,
        updatedAt: new Date(),
      }).where(and(
        eq(routesTable.id, args.routeId),
        eq(routesTable.organizationId, args.organizationId),
        eq(routesTable.lockedFirstStopId, args.stopId),
      ));
    }
    return transitionedStop ?? null;
  });
}
import { getDefaultBoundsPredictionResponse } from "./services/prediction";

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

export interface WsClient {
  workspaceToken?: string;
  ws: WebSocket;
  sessionId: string;
  sessionToken: string;
  userId: string;
  organizationId: string;
  role: "admin" | "dispatcher" | "driver" | "viewer";
  driverProfileId: string | null;
  driverVehicleId: string | null;
  subscribedPredictions?: boolean;
}

const clients: Set<WsClient> = new Set();
let broadcastTimer: ReturnType<typeof setInterval> | null = null;
let predictionTimer: ReturnType<typeof setInterval> | null = null;
export const MAX_PENDING_AUTH_MESSAGES = 16;
export const MAX_PENDING_AUTH_BYTES = 64 * 1024;

function rawDataByteLength(raw: RawData): number {
  if (Array.isArray(raw)) {
    return raw.reduce((total, part) => total + part.byteLength, 0);
  }
  return raw.byteLength;
}

export function enqueuePendingAuthMessage(
  pendingMessages: RawData[],
  raw: RawData,
  currentBytes: number,
): number | null {
  const nextBytes = currentBytes + rawDataByteLength(raw);
  if (
    pendingMessages.length >= MAX_PENDING_AUTH_MESSAGES
    || nextBytes > MAX_PENDING_AUTH_BYTES
  ) {
    return null;
  }
  pendingMessages.push(raw);
  return nextBytes;
}

export function getWebSocketSessionToken(headers: {
  authorization?: string | string[];
  cookie?: string;
}): string | null {
  const authorization = Array.isArray(headers.authorization)
    ? headers.authorization[0]
    : headers.authorization;
  const bearer = authorization?.match(/^Bearer\s+(.+)$/i)?.[1]?.trim();
  if (bearer) return bearer;

  const cookie = headers.cookie;
  if (!cookie) return null;
  const sessionPair = cookie.split(";").find((part) => part.trim().startsWith("routeai_session="));
  if (!sessionPair) return null;
  const value = sessionPair.trim().slice("routeai_session=".length);
  if (!value) return null;
  try {
    return decodeURIComponent(value);
  } catch {
    return null;
  }
}

export type ComputedPosition = {
  vehicleId: string;
  vehicleName: string;
  vehicleType: string;
  licensePlate: string;
  latitude: number;
  longitude: number;
  heading: number;
  speedKmh: number;
  routeId: string;
  routeName: string;
  nextStopAddress: string | null;
  etaMinutes: number | null;
  batteryPercent: number | null;
  distanceTravelledKm: number;
  isRealGps: true;
  measuredAt: string;
  handoffDriverId: string | null;
};

/**
 * Build a position projection from current execution telemetry only. Polling
 * must never advance a route or stop lifecycle, create a geofence event,
 * notify a customer, or publish a completion event.
 */
export async function computePositions(organizationId: string): Promise<ComputedPosition[]> {
  const workingRoutes = await db
    .select()
    .from(routesTable)
    .where(and(
      eq(routesTable.organizationId, organizationId),
      eq(routesTable.handoffStatus, "accepted"),
    ));
  const activeRoutes = (await Promise.all(workingRoutes.map(async (route) => {
    try { return route.dispatchSnapshotVersion != null ? await outgoingRoute(route) : null; }
    catch { return null; }
  }))).filter((route): route is NonNullable<typeof route> => route != null && route.status === "in_progress");
  if (activeRoutes.length === 0) return [];

  const positions: ComputedPosition[] = [];

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

    const stops = await outgoingStops(route);
    if (stops.length === 0) continue;

    const realPos = await getLatestPositionEvidence(organizationId, vehicle.id);
    if (!realPos) continue;
    const pos = {
      latitude: realPos.latitude,
      longitude: realPos.longitude,
      heading: realPos.heading,
    };
    const currentSpeed = realPos.speedKmh;

    let nextStopIdx = -1;
    let etaMin: number | null = null;
    for (let i = 0; i < stops.length; i++) {
      if (stops[i].status === "pending" || stops[i].status === "in_progress") {
        nextStopIdx = i;
        if (currentSpeed > 0) {
          const distToNextStop = haversineDistance(
            pos.latitude,
            pos.longitude,
            stops[i].latitude,
            stops[i].longitude,
          );
          etaMin = Math.round((distToNextStop / currentSpeed) * 60);
        }
        break;
      }
    }

    if (route.executionProjection?.selectionChangedAt && nextStopIdx >= 0) {
      const { driverArrivals } = await import("./services/driver-arrival");
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
      isRealGps: true,
      measuredAt: new Date(realPos.timestamp).toISOString(),
      handoffDriverId: route.handoffDriverId,
    });
  }

  return positions;
}

function removeAndCloseClient(client: WsClient, reason: string) {
  clients.delete(client);
  if (client.ws.readyState === WebSocket.OPEN || client.ws.readyState === WebSocket.CONNECTING) {
    client.ws.close(1008, reason);
  }
}

export async function canReceiveTenantEvent(client: WsClient, validateSession = validateSessionWithoutTouch): Promise<boolean> {
  const session = await validateSession(client.sessionToken);
  if (
    !session ||
    session.id !== client.sessionId ||
    session.userId !== client.userId ||
    (!client.workspaceToken && session.organizationId !== client.organizationId)
  ) {
    return false;
  }
  if (client.workspaceToken) {
    if (session.driverAccess) return false;
    const workspace = await resolveWorkspace(client.workspaceToken, session.tokenHash, client.userId);
    if (!workspace || workspace.organizationId !== client.organizationId) return false;
    client.role = "admin";
    client.driverProfileId = null;
    client.driverVehicleId = null;
    return true;
  }

  let [user] = await db
    .select({
      id: usersTable.id,
      role: usersTable.role,
      driverProfileId: usersTable.driverProfileId,
    })
    .from(usersTable)
    .where(and(eq(usersTable.id, client.userId), eq(usersTable.organizationId, client.organizationId)))
    .limit(1);
  if (!user) return false;
  user = driverSessionUser(user, session);

  client.role = user.role;
  client.driverProfileId = user.driverProfileId;
  client.driverVehicleId = null;
  if (user.role === "driver" && user.driverProfileId) {
    const [driver] = await db
      .select({ vehicleId: driversTable.vehicleId })
      .from(driversTable)
      .where(and(
        eq(driversTable.id, user.driverProfileId),
        eq(driversTable.organizationId, client.organizationId),
        eq(driversTable.isActive, true),
      ))
      .limit(1);
    client.driverVehicleId = driver?.vehicleId ?? null;
  }
  return true;
}

export async function sendTenantEvent(
  client: WsClient,
  message: string,
  verify: (client: WsClient) => Promise<boolean> = canReceiveTenantEvent,
) {
  try {
    if (client.ws.readyState !== WebSocket.OPEN || !(await verify(client))) {
      removeAndCloseClient(client, "Session is no longer valid");
      return;
    }
    if (client.role === "driver") {
      const event = JSON.parse(message) as { type: string; data?: Record<string, unknown>; timestamp?: number };
      const data = event.data ?? {};
      const routeId = typeof data.routeId === "string" ? data.routeId
        : event.type.startsWith("data:route:") && typeof data.id === "string" ? data.id : null;
      const stopId = typeof data.stopId === "string" ? data.stopId
        : event.type.startsWith("data:stop:") && typeof data.id === "string" ? data.id : null;
      if (!client.driverProfileId) return;
      if (stopId) {
        try { await outgoingStopContext(client.organizationId, stopId, client.driverProfileId); }
        catch { return; }
      } else if (routeId) {
        const [route] = await db.select().from(routesTable).where(and(
          eq(routesTable.id, routeId), eq(routesTable.organizationId, client.organizationId),
          eq(routesTable.handoffDriverId, client.driverProfileId),
        ));
        if (!route) return;
        try { await outgoingRoute(route); } catch { return; }
      } else {
        // Generic tenant planning feeds may include new work, resource names,
        // instructions or alternative geometry. Drivers receive none of it.
        return;
      }
      message = JSON.stringify({
        type: event.type, data: {
          ...(routeId ? { routeId, ...(event.type.startsWith("data:route:") ? { id: routeId } : {}) } : {}),
          ...(stopId ? { stopId, ...(event.type.startsWith("data:stop:") ? { id: stopId } : {}) } : {}),
        }, timestamp: event.timestamp,
      });
    }
    await new Promise<void>((resolve, reject) => {
      client.ws.send(message, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } catch {
    removeAndCloseClient(client, "Authentication unavailable");
  }
}

async function broadcast(organizationId: string, type: string, payload: unknown, relay = true) {
  if (relay) {
    // Deliver locally even if the database relay fails; the failure is logged
    // and health reports the listener state. Never undo an already committed
    // route mutation because an event could not be delivered.
    await publishRealtimeEvent({ organizationId, type, payload }).catch(() => {
      logger.error({ event: "realtime_relay_publish_failed" }, "Could not relay realtime event");
    });
  }
  if (type === "vehicles:positions" && Array.isArray(payload)) {
    await Promise.all(
      [...clients]
        .filter((client) => client.organizationId === organizationId)
        .map((client) => sendPositionEvent(client, payload as ComputedPosition[])),
    );
    return;
  }
  const message = JSON.stringify({ type, data: payload, timestamp: Date.now() });
  await Promise.all(
    [...clients]
      .filter((client) => client.organizationId === organizationId)
      .map((client) => sendTenantEvent(client, message)),
  );
}

export function projectPositionForClient(
  client: WsClient,
  position: ComputedPosition,
) {
  if (
    client.role === "driver"
    && (
      !client.driverProfileId
      || position.handoffDriverId !== client.driverProfileId
    )
  ) {
    return null;
  }

  const { handoffDriverId: _handoffDriverId, ...publicPosition } = position;
  if (client.role === "viewer") {
    return {
      ...publicPosition,
      nextStopAddress: null,
      etaMinutes: null,
    };
  }
  return publicPosition;
}

async function sendPositionEvent(client: WsClient, positions: ComputedPosition[]) {
  try {
    const canReceive = client.ws.readyState === WebSocket.OPEN && await canReceiveTenantEvent(client);
    if (!canReceive) {
      removeAndCloseClient(client, "Session is no longer valid");
      return;
    }
    const projectedPositions = positions
      .map((position) => projectPositionForClient(client, position))
      .filter((position): position is NonNullable<typeof position> => position !== null);
    await new Promise<void>((resolve, reject) => {
      client.ws.send(JSON.stringify({
        type: "vehicles:positions",
        data: projectedPositions,
        timestamp: Date.now(),
      }), (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  } catch {
    removeAndCloseClient(client, "Authentication unavailable");
  }
}

/** Publish an event only to authenticated clients belonging to one tenant. */
export async function broadcastTenantEvent(
  organizationId: string,
  type: string,
  payload: unknown,
) {
  await broadcast(organizationId, type, payload);
}

export async function broadcastPositions() {
  const orgIds = new Set<string>();
  for (const client of clients) {
    if (client.ws.readyState === WebSocket.OPEN) {
      orgIds.add(client.organizationId);
    }
  }

  for (const orgId of orgIds) {
    try {
      const positions = await computePositions(orgId);
      await Promise.all(
        [...clients]
          .filter((client) => client.organizationId === orgId)
          .map((client) => sendPositionEvent(client, positions)),
      );
    } catch (err) {
      console.error(`WS broadcast error for org ${orgId}:`, err);
    }
  }
}

async function broadcastPredictions() {
  const predictions = getDefaultBoundsPredictionResponse();
  const message = JSON.stringify({ type: "predictions:update", data: predictions, timestamp: Date.now() });
  await Promise.all(
    [...clients]
      .filter((client) => client.subscribedPredictions)
      .map((client) => sendTenantEvent(client, message)),
  );
}

export function setupWebSocket(
  server: Server,
  options: { startBroadcasts?: boolean; validateSession?: typeof validateAndTouchSession } = {},
) {
  // The API prefix is routed to this service by the workspace proxy.
  // Keep /ws for existing direct clients; both paths share authentication.
  const wss = new WebSocketServer({
    server,
    verifyClient: ({ req }: { req: import("node:http").IncomingMessage }) => {
      const path = req.url?.split("?")[0];
      return path === "/api/ws" || path === "/ws";
    },
  });
  const stopRelay = startRealtimeRelay(event =>
    broadcast(event.organizationId, event.type, event.payload, false));
  wss.once("close", stopRelay);

  wss.on("connection", async (ws, request) => {
    const pendingMessages: RawData[] = [];
    let pendingMessageBytes = 0;
    let handshakeOverflow = false;
    let handleAuthenticatedMessage: ((raw: RawData) => void) | null = null;
    ws.on("message", (raw) => {
      if (handshakeOverflow) return;
      if (handleAuthenticatedMessage) {
        handleAuthenticatedMessage(raw);
      } else {
        const nextBytes = enqueuePendingAuthMessage(
          pendingMessages,
          raw,
          pendingMessageBytes,
        );
        if (nextBytes === null) {
          handshakeOverflow = true;
          pendingMessages.length = 0;
          pendingMessageBytes = 0;
          ws.close(1009, "Authentication message limit exceeded");
          return;
        }
        pendingMessageBytes = nextBytes;
      }
    });

    const token = getWebSocketSessionToken(request.headers);
    if (!token) {
      ws.close(1008, "Authentication required");
      return;
    }

    let session;
    try {
      session = await (options.validateSession ?? validateAndTouchSession)(token);
    } catch {
      ws.close(1011, "Authentication unavailable");
      return;
    }
    if (handshakeOverflow || ws.readyState !== WebSocket.OPEN) return;
    if (!session) {
      ws.close(1008, "Authentication required");
      return;
    }
    let user: {
      id: string;
      role: "admin" | "dispatcher" | "driver" | "viewer";
      driverProfileId: string | null;
    } | undefined;
    try {
      [user] = await db
        .select({
          id: usersTable.id,
          role: usersTable.role,
          driverProfileId: usersTable.driverProfileId,
        })
        .from(usersTable)
        .where(and(eq(usersTable.id, session.userId), eq(usersTable.organizationId, session.organizationId)))
        .limit(1);
    } catch {
      ws.close(1011, "Authentication unavailable");
      return;
    }
    if (handshakeOverflow || ws.readyState !== WebSocket.OPEN) return;
    if (!user) {
      ws.close(1008, "Authentication required");
      return;
    }
    user = driverSessionUser(user, session);

    // The validated session, rather than a subscribe message, owns the
    // websocket tenant scope for the lifetime of this connection.
    const workspaceToken = request.headers["sec-websocket-protocol"]?.split(",")
      .map(value => value.trim()).find(value => value.startsWith("workspace."))?.slice(10);
    let organizationId = session.organizationId;
    if (workspaceToken) {
      if (session.driverAccess) { ws.close(1008, "Driver session"); return; }
      try {
        const workspace = await resolveWorkspace(workspaceToken, session.tokenHash, session.userId);
        if (!workspace) { ws.close(1008, "Workspace expired"); return; }
        organizationId = workspace.organizationId;
        user = { ...user, role: "admin", driverProfileId: null };
      } catch { ws.close(1011, "Workspace unavailable"); return; }
    }
    let client: WsClient | null = null;

    handleAuthenticatedMessage = (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        if (msg.type === "subscribe") {
          if (workspaceToken && msg.organizationId !== organizationId) {
            ws.close(1008, "Workspace target mismatch"); return;
          }
          if (client) clients.delete(client);
          client = {
            ws,
            sessionId: session.id,
            sessionToken: token,
            workspaceToken,
            userId: session.userId,
            organizationId,
            role: user.role,
            driverProfileId: user.driverProfileId,
            driverVehicleId: null,
          };
          clients.add(client);
          ws.send(JSON.stringify({ type: "subscribed", organizationId }));
        } else if (msg.type === "subscribe-predictions" && client) {
          client.subscribedPredictions = true;
          ws.send(JSON.stringify({ type: "subscribed-predictions" }));
        } else if (msg.type === "unsubscribe-predictions" && client) {
          client.subscribedPredictions = false;
        } else if (msg.type === "disruption") {
          ws.send(JSON.stringify({
            type: "error",
            code: "WS_MUTATION_NOT_ALLOWED",
            message: "WebSocket disruption mutations are not allowed; use the authorized HTTP planning API.",
          }));
        }
      } catch {}
    };
    for (const pendingMessage of pendingMessages.splice(0)) {
      handleAuthenticatedMessage(pendingMessage);
    }
    pendingMessageBytes = 0;

    ws.on("close", () => {
      if (client) clients.delete(client);
    });

    ws.on("error", () => {
      if (client) clients.delete(client);
    });
  });

  if (options.startBroadcasts !== false) {
    broadcastTimer = setInterval(broadcastPositions, BROADCAST_INTERVAL_MS);
    predictionTimer = setInterval(() => { void broadcastPredictions(); }, 30_000);
  }
  wss.on("close", () => {
    if (broadcastTimer) clearInterval(broadcastTimer);
    if (predictionTimer) clearInterval(predictionTimer);
    broadcastTimer = null;
    predictionTimer = null;
  });

  console.log("WebSocket server ready on /api/ws (legacy /ws supported)");
  return wss;
}

type DisruptionEvent = {
  type: "disruption";
  disruptionType: "traffic_delay" | "vehicle_breakdown" | "stop_added" | "stop_cancelled";
  organizationId: string;
  routeIds?: string[];
  affectedStopId?: string;
  reason?: string;
};

type DisruptionStopPlanningFields = Pick<
  typeof stopsTable.$inferSelect,
  | "id"
  | "jobType"
  | "latitude"
  | "longitude"
  | "timeWindowStart"
  | "timeWindowEnd"
  | "serviceDurationMin"
  | "weightKg"
  | "volumeM3"
  | "priority"
  | "pickupAddress"
  | "pickupLatitude"
  | "pickupLongitude"
  | "requiredSkills"
  | "requiredCertifications"
  | "requiredEquipment"
> & {
  unavailablePeriods?: unknown;
};
export function disruptionNodeForPlanning(
  stop: DisruptionStopPlanningFields,
  planningInputs: ReturnType<typeof normalizePlanningInputs>,
): ALNSNode {
  return {
    id: stop.id,
    jobType: stop.jobType ?? "delivery",
    latitude: stop.latitude,
    longitude: stop.longitude,
    timeWindowStart: stop.timeWindowStart,
    timeWindowEnd: stop.timeWindowEnd,
    serviceDurationMin: stop.serviceDurationMin,
    ...(stop.unavailablePeriods != null
      ? {
          unavailablePeriods: stop.unavailablePeriods as Array<{
            start: string;
            end: string;
          }>,
        }
      : {}),
    weightKg: Number(stop.weightKg) || 0,
    volumeM3: Number(stop.volumeM3) || 0,
    planningPriority: planningInputs.stopPriorities[stop.id]
      ?? (stop.priority === 2 ? 2 : stop.priority === 1 ? 1 : 0),
    stopReserveMin: planningInputs.stopReserveMin,
    travelReservePercent: planningInputs.travelReservePercent,
    ...(stop.pickupAddress && stop.pickupLatitude != null && stop.pickupLongitude != null
      ? {
          pickupLat: stop.pickupLatitude,
          pickupLon: stop.pickupLongitude,
          pickupServiceMin: stop.serviceDurationMin,
        }
      : {}),
    ...(stop.requiredSkills?.length ? { requiredSkills: stop.requiredSkills } : {}),
    ...(stop.requiredCertifications?.length
      ? { requiredCertifications: stop.requiredCertifications }
      : {}),
    ...(stop.requiredEquipment?.length ? { requiredEquipment: stop.requiredEquipment } : {}),
  };
}

async function handleDisruptionReoptimize(event: DisruptionEvent) {
  const { organizationId, disruptionType, routeIds, affectedStopId, reason } = event;

  const activeOptimizer = getActiveOptimizer(organizationId);
  if (activeOptimizer?.isRunning()) {
    if (disruptionType === "stop_added" && affectedStopId) {
      const [newStop] = await db.select().from(stopsTable).where(
        and(eq(stopsTable.id, affectedStopId), eq(stopsTable.organizationId, organizationId))
      );
      if (newStop) {
        await activeOptimizer.injectDisruption([{
          id: newStop.id,
          latitude: newStop.latitude,
          longitude: newStop.longitude,
          timeWindowStart: newStop.timeWindowStart,
          timeWindowEnd: newStop.timeWindowEnd,
          serviceDurationMin: newStop.serviceDurationMin,
          weightKg: Number(newStop.weightKg) || 0,
          volumeM3: Number(newStop.volumeM3) || 0,
           ...((newStop as typeof newStop & { unavailablePeriods?: unknown })
             .unavailablePeriods != null
             ? {
                 unavailablePeriods: (newStop as typeof newStop & {
                   unavailablePeriods?: unknown;
                 }).unavailablePeriods as Array<{ start: string; end: string }>,
               }
             : {}),
        }]);
      }
    } else if (disruptionType === "stop_cancelled" && affectedStopId) {
      await activeOptimizer.injectDisruption([], [affectedStopId]);
    } else if (disruptionType === "traffic_delay" || disruptionType === "vehicle_breakdown") {
      await activeOptimizer.injectDisruption([], []);
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
  const [allOrgVehicles, activeDrivers, organizations] = await Promise.all([
    db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId)),
    db.select().from(driversTable).where(and(
      eq(driversTable.organizationId, organizationId),
      eq(driversTable.isActive, true),
    )),
    db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)),
  ]);
  const currentDepotSnapshot = verifiedDepotSnapshot(organizations[0]);
  const routeByVehicleId = new Map(
    affectedRoutes
      .filter((route): route is typeof route & { vehicleId: string } => route.vehicleId != null)
      .map((route) => [route.vehicleId, route]),
  );
  const driverByVehicleId = new Map(
    activeDrivers
      .filter((driver): driver is typeof driver & { vehicleId: string } => driver.vehicleId != null)
      .map((driver) => [driver.vehicleId, driver]),
  );
  const planningInputsByRouteId = new Map(
    affectedRoutes.map((route) => [
      route.id,
      normalizePlanningInputs(route.optimizationPlanningSnapshot),
    ]),
  );

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
    const planningInputs = planningInputsByRouteId.get(r.id)
      ?? normalizePlanningInputs(null);
    const nodes: ALNSNode[] = routeStops.map(s => disruptionNodeForPlanning(s, planningInputs));
    return {
      vehicleId: r.vehicleId ?? "",
      nodes,
      totalWeight: nodes.reduce((sum, n) => sum + (n.weightKg ?? 0), 0),
      totalVolume: nodes.reduce((sum, n) => sum + (n.volumeM3 ?? 0), 0),
      lockedFirstStopId: r.lockedFirstStopId,
    };
  });

  const alnsVehicles: ALNSVehicle[] = allOrgVehicles.map(v => {
    const driver = driverByVehicleId.get(v.id);
    const routingVehicle = driver
      ? applyDriverRoutingProfile({
          id: v.id,
          vehicleType: v.vehicleType,
          capacityKg: v.capacityKg,
          capacityVolume: v.capacityVolume,
          rangeKm: v.rangeKm,
        }, driver)
      : {
          id: v.id,
          vehicleType: v.vehicleType,
          capacityKg: v.capacityKg,
          capacityVolume: v.capacityVolume,
          rangeKm: v.rangeKm,
        };
    const depotSnapshot = routeByVehicleId.get(v.id)?.depotSnapshot ?? currentDepotSnapshot;
    const route = routeByVehicleId.get(v.id);
    if (route) {
      routingVehicle.travelReservePercent =
        planningInputsByRouteId.get(route.id)?.travelReservePercent
        ?? normalizePlanningInputs(null).travelReservePercent;
    }
    if (depotSnapshot) {
      routingVehicle.startLatitude = depotSnapshot.start.latitude;
      routingVehicle.startLongitude = depotSnapshot.start.longitude;
      routingVehicle.endLatitude = depotSnapshot.end.latitude;
      routingVehicle.endLongitude = depotSnapshot.end.longitude;
    }
    return routingVehicle;
  });
  const driverConstraints = [...driverByVehicleId.values()]
    .filter((driver) => affectedVehicleIds.includes(driver.vehicleId))
    .map(routingConstraintsForDriver);
  const firstRouteDepot =
    affectedRoutes.find((route) => route.depotSnapshot)?.depotSnapshot ??
    currentDepotSnapshot;
  const firstVehicle = alnsVehicles.find((vehicle) => affectedVehicleIds.includes(vehicle.id));
  const depotLatitude = firstRouteDepot?.start.latitude ?? firstVehicle?.startLatitude ?? DEPOT_LAT;
  const depotLongitude = firstRouteDepot?.start.longitude ?? firstVehicle?.startLongitude ?? DEPOT_LON;

  const result = await reoptimizeAffectedRoutes(
    currentALNSRoutes, affectedVehicleIds, alnsVehicles,
    depotLatitude, depotLongitude, affectedRoutes[0]?.date ?? new Date(),
    { timeLimitMs: 10000, driverConstraints }
  );

  const sourceRouteByStopId = new Map(
    allAffectedStops.map((stop) => [stop.id, stop.routeId]),
  );
  const diagnosticResources = affectedRoutes.flatMap((route) => {
    if (!route.vehicleId) return [];
    const vehicle = allOrgVehicles.find((candidate) => candidate.id === route.vehicleId);
    const driver = driverByVehicleId.get(route.vehicleId);
    const routingVehicle = alnsVehicles.find((candidate) => candidate.id === route.vehicleId);
    return vehicle && driver && routingVehicle
      ? [{ vehicle, driver, routingVehicle }]
      : [];
  });
  const unplannedNodes = result.unassigned.filter((node) => !node.isChargingStation);
  const diagnostics = classifyUnplannedNodes(
    unplannedNodes,
    new Map(allAffectedStops.map((stop) => [stop.id, stop])),
    diagnosticResources,
    depotLatitude,
    depotLongitude,
    affectedRoutes[0]?.date ?? new Date(),
  );
  const diagnosticByStopId = new Map(diagnostics.map((diagnostic) => [
    diagnostic.stopId,
    diagnostic.detail,
  ]));
  const planningSummaryByRouteId = new Map(affectedRoutes.map((route) => {
    const planningInputs = planningInputsByRouteId.get(route.id)
      ?? normalizePlanningInputs(null);
    const routeUnplanned = unplannedNodes.filter(
      (node) => sourceRouteByStopId.get(node.id) === route.id,
    );
    return [route.id, refreshedPlanningSummary(
      route.planningSummary,
      planningInputs,
      routeUnplanned,
      diagnosticByStopId,
    )];
  }));

  const reoptimizedRouteIds: string[] = [];
  await db.transaction(async (tx) => {
    await lockAndValidateReoptimizationSnapshot(
      tx,
      organizationId,
      affectedRoutes,
      pendingStops,
    );
    for (const stop of pendingStops) {
      await tx.update(stopsTable).set({
        routeId: null,
        sequenceOrder: null,
        unplannedReason: null,
      })
        .where(and(eq(stopsTable.id, stop.id), eq(stopsTable.organizationId, organizationId)));
    }
    for (const node of unplannedNodes) {
      const sourceRoute = affectedRoutes.find(
        (route) => route.id === sourceRouteByStopId.get(node.id),
      );
      await tx.update(stopsTable).set({
        routeId: null,
        sequenceOrder: null,
        planningPlanId: sourceRoute?.planId ?? null,
        planningDate: sourceRoute?.date ?? affectedRoutes[0]?.date ?? null,
        unplannedReason: diagnosticByStopId.get(node.id)
          ?? "Stoppet kunde inte tilldelas inom valda resurser och hårda planeringsvillkor.",
      }).where(and(
        eq(stopsTable.id, node.id),
        eq(stopsTable.organizationId, organizationId),
      ));
    }

    for (const existingRoute of affectedRoutes) {
      const alnsRoute = result.routes.find((route) => route.vehicleId === existingRoute.vehicleId);
      const nodes = alnsRoute?.nodes ?? [];
      const vehicle = existingRoute.vehicleId
        ? allOrgVehicles.find(candidate => candidate.id === existingRoute.vehicleId)
        : undefined;
      const routingVehicle = existingRoute.vehicleId
        ? alnsVehicles.find(candidate => candidate.id === existingRoute.vehicleId)
        : undefined;
      const driver = existingRoute.vehicleId
        ? driverByVehicleId.get(existingRoute.vehicleId)
        : undefined;
      const constraints = existingRoute.vehicleId
        ? driverConstraints.find(candidate => candidate.vehicleId === existingRoute.vehicleId)
        : undefined;
      if (!vehicle || !routingVehicle || !driver || !alnsRoute) {
        throw new Error("Rutten saknar en aktiv bil eller chaufför för störningsomplanering.");
      }
      const depotSnapshot = existingRoute.depotSnapshot ?? currentDepotSnapshot;
      const routeDepotLatitude = depotSnapshot?.start.latitude ?? routingVehicle.startLatitude ?? depotLatitude;
      const routeDepotLongitude = depotSnapshot?.start.longitude ?? routingVehicle.startLongitude ?? depotLongitude;
      const workday = evaluateRouteWorkday(
        nodes,
        routingVehicle,
        routeDepotLatitude,
        routeDepotLongitude,
        existingRoute.date,
        constraints,
      );
      if (!workday.feasible) {
        throw new Error(workdayInfeasibilityMessage(workday, {
          vehicleName: vehicle.name,
          breakStartTime: driver.breakStartTime,
          breakEndTime: driver.breakEndTime,
        }));
      }
      const plannerItinerary = itineraryForNodes(
        nodes,
        routingVehicle,
        driver,
        routeDepotLatitude,
        routeDepotLongitude,
        existingRoute.date,
      );
      for (const entry of plannerItinerary.filter((item) => !item.isChargingStop)) {
        await tx.update(stopsTable)
          .set({
            routeId: existingRoute.id,
            sequenceOrder: entry.sequenceOrder,
            planningPlanId: existingRoute.planId ?? null,
            planningDate: existingRoute.date,
            unplannedReason: null,
          })
          .where(and(eq(stopsTable.id, entry.stopId), eq(stopsTable.organizationId, organizationId)));
      }
      const co2 = estimateCo2(
        workday.totalDistanceKm,
        vehicle.vehicleType,
        alnsRoute.totalWeight,
        routingVehicle.capacityKg,
      );
      const [updatedRoute] = await tx.update(routesTable).set({
        totalDistanceKm: Math.round(workday.totalDistanceKm * 100) / 100,
        totalDurationMin: Math.round(workday.summary.totalMin * 100) / 100,
        co2EmissionsKg: Math.round(co2 * 100) / 100,
        totalStops: nodes.filter(n => !n.isChargingStation).length,
        plannerItinerary,
        depotSnapshot,
        workdayTimeline: workday.events,
        workdaySummary: workday.summary,
        planningSummary: planningSummaryByRouteId.get(existingRoute.id),
        executionProjection: null,
        redistributionSuggestion: null,
        planRevision: sql`${routesTable.planRevision} + 1`,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: null,
        sentAt: null,
        receivedAt: null,
        openedAt: null,
        acceptedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        updatedAt: new Date(),
      }).where(and(
        eq(routesTable.id, existingRoute.id),
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planRevision, existingRoute.planRevision),
      )).returning({ id: routesTable.id });
      if (!updatedRoute) {
        throw new Error("Route changed while applying disruption re-optimization");
      }

      reoptimizedRouteIds.push(existingRoute.id);
    }
  });

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
if (false) {
async function handleDisruptionReoptimize(event: DisruptionEvent) {
  const { organizationId, disruptionType, routeIds, affectedStopId, reason } = event;

  const activeOptimizer = getActiveOptimizer(organizationId);
  if (activeOptimizer?.isRunning()) {
    if (disruptionType === "stop_added" && affectedStopId) {
      const [newStop] = await db.select().from(stopsTable).where(
        and(eq(stopsTable.id, affectedStopId), eq(stopsTable.organizationId, organizationId))
      );
      if (newStop) {
        await activeOptimizer.injectDisruption([{
          id: newStop.id,
          latitude: newStop.latitude,
          longitude: newStop.longitude,
          timeWindowStart: newStop.timeWindowStart,
          timeWindowEnd: newStop.timeWindowEnd,
          serviceDurationMin: newStop.serviceDurationMin,
          weightKg: Number(newStop.weightKg) || 0,
          volumeM3: Number(newStop.volumeM3) || 0,
           ...((newStop as typeof newStop & { unavailablePeriods?: unknown })
             .unavailablePeriods != null
             ? {
                 unavailablePeriods: (newStop as typeof newStop & {
                   unavailablePeriods?: unknown;
                 }).unavailablePeriods as Array<{ start: string; end: string }>,
               }
             : {}),
        }]);
      }
    } else if (disruptionType === "stop_cancelled" && affectedStopId) {
      await activeOptimizer.injectDisruption([], [affectedStopId]);
    } else if (disruptionType === "traffic_delay" || disruptionType === "vehicle_breakdown") {
      await activeOptimizer.injectDisruption([], []);
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
  const [allOrgVehicles, activeDrivers, organizations] = await Promise.all([
    db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId)),
    db.select().from(driversTable).where(and(
      eq(driversTable.organizationId, organizationId),
      eq(driversTable.isActive, true),
    )),
    db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId)),
  ]);
  const currentDepotSnapshot = verifiedDepotSnapshot(organizations[0]);
  const routeByVehicleId = new Map(
    affectedRoutes
      .filter((route): route is typeof route & { vehicleId: string } => route.vehicleId != null)
      .map((route) => [route.vehicleId, route]),
  );
  const driverByVehicleId = new Map(
    activeDrivers
      .filter((driver): driver is typeof driver & { vehicleId: string } => driver.vehicleId != null)
      .map((driver) => [driver.vehicleId, driver]),
  );
  const planningInputsByRouteId = new Map(
    affectedRoutes.map((route) => [
      route.id,
      normalizePlanningInputs(route.optimizationPlanningSnapshot),
    ]),
  );

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
    const planningInputs = planningInputsByRouteId.get(r.id)
      ?? normalizePlanningInputs(null);
    const nodes: ALNSNode[] = routeStops.map(s => disruptionNodeForPlanning(s, planningInputs));
    return {
      vehicleId: r.vehicleId ?? "",
      nodes,
      totalWeight: nodes.reduce((sum, n) => sum + (n.weightKg ?? 0), 0),
      totalVolume: nodes.reduce((sum, n) => sum + (n.volumeM3 ?? 0), 0),
      lockedFirstStopId: r.lockedFirstStopId,
    };
  });

  const alnsVehicles: ALNSVehicle[] = allOrgVehicles.map(v => {
    const driver = driverByVehicleId.get(v.id);
    const routingVehicle = driver
      ? applyDriverRoutingProfile({
          id: v.id,
          vehicleType: v.vehicleType,
          capacityKg: v.capacityKg,
          capacityVolume: v.capacityVolume,
          rangeKm: v.rangeKm,
        }, driver)
      : {
          id: v.id,
          vehicleType: v.vehicleType,
          capacityKg: v.capacityKg,
          capacityVolume: v.capacityVolume,
          rangeKm: v.rangeKm,
        };
    const depotSnapshot = routeByVehicleId.get(v.id)?.depotSnapshot ?? currentDepotSnapshot;
    const route = routeByVehicleId.get(v.id);
    if (route) {
      routingVehicle.travelReservePercent =
        planningInputsByRouteId.get(route.id)?.travelReservePercent
        ?? normalizePlanningInputs(null).travelReservePercent;
    }
    if (depotSnapshot) {
      routingVehicle.startLatitude = depotSnapshot.start.latitude;
      routingVehicle.startLongitude = depotSnapshot.start.longitude;
      routingVehicle.endLatitude = depotSnapshot.end.latitude;
      routingVehicle.endLongitude = depotSnapshot.end.longitude;
    }
    return routingVehicle;
  });
  const driverConstraints = [...driverByVehicleId.values()]
    .filter((driver) => affectedVehicleIds.includes(driver.vehicleId))
    .map(routingConstraintsForDriver);
  const firstRouteDepot =
    affectedRoutes.find((route) => route.depotSnapshot)?.depotSnapshot ??
    currentDepotSnapshot;
  const firstVehicle = alnsVehicles.find((vehicle) => affectedVehicleIds.includes(vehicle.id));
  const depotLatitude = firstRouteDepot?.start.latitude ?? firstVehicle?.startLatitude ?? DEPOT_LAT;
  const depotLongitude = firstRouteDepot?.start.longitude ?? firstVehicle?.startLongitude ?? DEPOT_LON;

  const result = await reoptimizeAffectedRoutes(
    currentALNSRoutes, affectedVehicleIds, alnsVehicles,
    depotLatitude, depotLongitude, affectedRoutes[0]?.date ?? new Date(),
    { timeLimitMs: 10000, driverConstraints }
  );

  const sourceRouteByStopId = new Map(
    allAffectedStops.map((stop) => [stop.id, stop.routeId]),
  );
  const diagnosticResources = affectedRoutes.flatMap((route) => {
    if (!route.vehicleId) return [];
    const vehicle = allOrgVehicles.find((candidate) => candidate.id === route.vehicleId);
    const driver = driverByVehicleId.get(route.vehicleId);
    const routingVehicle = alnsVehicles.find((candidate) => candidate.id === route.vehicleId);
    return vehicle && driver && routingVehicle
      ? [{ vehicle, driver, routingVehicle }]
      : [];
  });
  const unplannedNodes = result.unassigned.filter((node) => !node.isChargingStation);
  const diagnostics = classifyUnplannedNodes(
    unplannedNodes,
    new Map(allAffectedStops.map((stop) => [stop.id, stop])),
    diagnosticResources,
    depotLatitude,
    depotLongitude,
    affectedRoutes[0]?.date ?? new Date(),
  );
  const diagnosticByStopId = new Map(diagnostics.map((diagnostic) => [
    diagnostic.stopId,
    diagnostic.detail,
  ]));
  const planningSummaryByRouteId = new Map(affectedRoutes.map((route) => {
    const planningInputs = planningInputsByRouteId.get(route.id)
      ?? normalizePlanningInputs(null);
    const routeUnplanned = unplannedNodes.filter(
      (node) => sourceRouteByStopId.get(node.id) === route.id,
    );
    return [route.id, refreshedPlanningSummary(
      route.planningSummary,
      planningInputs,
      routeUnplanned,
      diagnosticByStopId,
    )];
  }));

  const reoptimizedRouteIds: string[] = [];
  await db.transaction(async (tx) => {
    await lockAndValidateReoptimizationSnapshot(
      tx,
      organizationId,
      affectedRoutes,
      pendingStops,
    );
    for (const stop of pendingStops) {
      await tx.update(stopsTable).set({
        routeId: null,
        sequenceOrder: null,
        unplannedReason: null,
      })
        .where(and(eq(stopsTable.id, stop.id), eq(stopsTable.organizationId, organizationId)));
    }
    for (const node of unplannedNodes) {
      const sourceRoute = affectedRoutes.find(
        (route) => route.id === sourceRouteByStopId.get(node.id),
      );
      await tx.update(stopsTable).set({
        routeId: null,
        sequenceOrder: null,
        planningPlanId: sourceRoute?.planId ?? null,
        planningDate: sourceRoute?.date ?? affectedRoutes[0]?.date ?? null,
        unplannedReason: diagnosticByStopId.get(node.id)
          ?? "Stoppet kunde inte tilldelas inom valda resurser och hårda planeringsvillkor.",
      }).where(and(
        eq(stopsTable.id, node.id),
        eq(stopsTable.organizationId, organizationId),
      ));
    }

    for (const existingRoute of affectedRoutes) {
      const alnsRoute = result.routes.find((route) => route.vehicleId === existingRoute.vehicleId);
      const nodes = alnsRoute?.nodes ?? [];
      const vehicle = existingRoute.vehicleId
        ? allOrgVehicles.find(candidate => candidate.id === existingRoute.vehicleId)
        : undefined;
      const routingVehicle = existingRoute.vehicleId
        ? alnsVehicles.find(candidate => candidate.id === existingRoute.vehicleId)
        : undefined;
      const driver = existingRoute.vehicleId
        ? driverByVehicleId.get(existingRoute.vehicleId)
        : undefined;
      const constraints = existingRoute.vehicleId
        ? driverConstraints.find(candidate => candidate.vehicleId === existingRoute.vehicleId)
        : undefined;
      if (!vehicle || !routingVehicle || !driver || !alnsRoute) {
        throw new Error("Rutten saknar en aktiv bil eller chaufför för störningsomplanering.");
      }
      const depotSnapshot = existingRoute.depotSnapshot ?? currentDepotSnapshot;
      const routeDepotLatitude = depotSnapshot?.start.latitude ?? routingVehicle.startLatitude ?? depotLatitude;
      const routeDepotLongitude = depotSnapshot?.start.longitude ?? routingVehicle.startLongitude ?? depotLongitude;
      const workday = evaluateRouteWorkday(
        nodes,
        routingVehicle,
        routeDepotLatitude,
        routeDepotLongitude,
        existingRoute.date,
        constraints,
      );
      if (!workday.feasible) {
        throw new Error(workdayInfeasibilityMessage(workday, {
          vehicleName: vehicle.name,
          breakStartTime: driver.breakStartTime,
          breakEndTime: driver.breakEndTime,
        }));
      }
      const plannerItinerary = itineraryForNodes(
        nodes,
        routingVehicle,
        driver,
        routeDepotLatitude,
        routeDepotLongitude,
        existingRoute.date,
      );
      for (const entry of plannerItinerary.filter((item) => !item.isChargingStop)) {
        await tx.update(stopsTable)
          .set({
            routeId: existingRoute.id,
            sequenceOrder: entry.sequenceOrder,
            planningPlanId: existingRoute.planId ?? null,
            planningDate: existingRoute.date,
            unplannedReason: null,
          })
          .where(and(eq(stopsTable.id, entry.stopId), eq(stopsTable.organizationId, organizationId)));
      }
      const co2 = estimateCo2(
        workday.totalDistanceKm,
        vehicle.vehicleType,
        alnsRoute.totalWeight,
        routingVehicle.capacityKg,
      );
      const [updatedRoute] = await tx.update(routesTable).set({
        totalDistanceKm: Math.round(workday.totalDistanceKm * 100) / 100,
        totalDurationMin: Math.round(workday.summary.totalMin * 100) / 100,
        co2EmissionsKg: Math.round(co2 * 100) / 100,
        totalStops: nodes.filter(n => !n.isChargingStation).length,
        plannerItinerary,
        depotSnapshot,
        workdayTimeline: workday.events,
        workdaySummary: workday.summary,
        planningSummary: planningSummaryByRouteId.get(existingRoute.id),
        executionProjection: null,
        redistributionSuggestion: null,
        planRevision: sql`${routesTable.planRevision} + 1`,
        handoffStatus: "pending",
        handoffVersion: null,
        handoffDriverId: null,
        sentAt: null,
        receivedAt: null,
        openedAt: null,
        acceptedAt: null,
        rejectedAt: null,
        rejectionReason: null,
        updatedAt: new Date(),
      }).where(and(
        eq(routesTable.id, existingRoute.id),
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planRevision, existingRoute.planRevision),
      )).returning({ id: routesTable.id });
      if (!updatedRoute) {
        throw new Error("Route changed while applying disruption re-optimization");
      }

      reoptimizedRouteIds.push(existingRoute.id);
    }
  });

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
}

// The session module publishes revocations rather than importing this module,
// keeping session lifecycle ownership separate from websocket transport.
onSessionRevoked((sessionId) => {
  for (const client of [...clients]) {
    if (client.sessionId === sessionId) removeAndCloseClient(client, "Session revoked");
  }
});

export { broadcast };
