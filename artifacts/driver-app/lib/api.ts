import { Platform } from "react-native";
import { connection } from "./connection-config";
import { createAppError } from "./error-localizer";
import { ensureWorkExecution } from "./work-execution";
import { isServerSessionVerified, setServerSessionVerified, ensureServerSessionVerified } from "./session-verification";
export { isServerSessionVerified, subscribeToSessionVerification } from "./session-verification";

export function getApiBaseUrl(): string {
  return connection.apiBaseUrl;
}

const BASE_URL = getApiBaseUrl();

export async function ensureRouteExecutionForWork(routeId: string, planVersion: number, occurredAt?: string) {
  await ensureWorkExecution(routeId, planVersion, {
    getRoute: api.getRoute,
    getExecution: api.getRouteExecution,
    start: api.executeRouteLifecycle,
  }, occurredAt);
}

let authToken: string | null = null;
let sessionGeneration = 0;
let authenticatedOrganizationId: string | null = null;
let sessionExpiredHandler: (() => void | Promise<void>) | null = null;
let driverAssistanceContext: { driverId: string; routeId: string } | null = null;
// Driver-link sessions authenticate only by bearer. Cookies are omitted so a
// staff cookie on a shared browser can never override the driver identity.
let bearerOnlySession = false;

export function setBearerOnlySession(enabled: boolean) {
  bearerOnlySession = enabled;
}

const CREDENTIALED_AUTH_PATHS = new Set(["/auth/login", "/auth/mfa/verify", "/auth/mfa/resend"]);

export function requestCredentials(path: string, bearerOnly: boolean): RequestCredentials {
  if (path === "/auth/driver-link") return "omit";
  if (CREDENTIALED_AUTH_PATHS.has(path)) return "include";
  return bearerOnly ? "omit" : "include";
}

/**
 * Sets a token while its identity is being verified with /auth/me. This state
 * must not be used for tenant-scoped data requests.
 */
export function setPendingAuthToken(token: string) {
  sessionGeneration++;
  setServerSessionVerified(false);
  authToken = token;
  authenticatedOrganizationId = null;
}

/** Stores the bearer token and tenant from an authenticated login or /auth/me response. */
export function setAuthenticatedSession(token: string, organizationId: string) {
  authToken = token;
  authenticatedOrganizationId = organizationId;
  setServerSessionVerified(true);
}

export function clearAuthenticatedSession() {
  sessionGeneration++;
  setServerSessionVerified(false);
  authToken = null;
  authenticatedOrganizationId = null;
  driverAssistanceContext = null;
  bearerOnlySession = false;
}

/** Explicit execution scope for an admin helping one assigned driver. */
export function setDriverAssistanceContext(context: { driverId: string; routeId: string } | null) {
  driverAssistanceContext = context;
}

export function setSessionExpiredHandler(handler: (() => void | Promise<void>) | null) {
  sessionExpiredHandler = handler;
}

export function getAuthenticatedOrganizationId(): string {
  if (!authenticatedOrganizationId) {
    throw createAppError("sessionScope");
  }
  return authenticatedOrganizationId;
}

function organizationQuery(): string {
  return `organizationId=${encodeURIComponent(getAuthenticatedOrganizationId())}`;
}

export class ApiError extends Error {
  status: number;
  body: string;
  code?: string;
  requestId?: string;
  constructor(status: number, body: string, code?: string, requestId?: string) {
    // Keep the response body available for internal protocol checks (for
    // example stale-plan detection), but never put it in Error.message. UI
    // code must use the structured localizer rather than exposing backend
    // responses to a driver.
    super(status === 0 ? "NETWORK_ERROR" : `API_${status}`);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.code = code;
    this.requestId = requestId;
  }
}

export const isAuthError = (err: unknown) =>
  err instanceof ApiError && (err.status === 401 || err.status === 403);

export const isStalePlanError = (err: unknown) =>
  err instanceof ApiError &&
  err.status === 409 &&
  (err.body.includes("STALE_PLAN") ||
    err.body.toLowerCase().includes("stale plan") ||
    err.body.toLowerCase().includes("stale_plan") ||
    err.body.toLowerCase().includes("plan version") ||
    err.body.toLowerCase().includes("plan_version"));

async function request<T>(
  path: string,
  options?: RequestInit,
  sessionVerification = false,
): Promise<T> {
  if (!path.startsWith("/auth/") && !sessionVerification &&
      (!await ensureServerSessionVerified() || !isServerSessionVerified())) {
    throw new ApiError(0, "", "NETWORK_ERROR");
  }
  const generation = sessionGeneration;
  const url = `${BASE_URL}${path}`;
  let res: Response;
  try {
    res = await fetch(url, {
      ...options,
      credentials: requestCredentials(path, bearerOnlySession),
      headers: {
        "Content-Type": "application/json",
        ...(authToken ? { Authorization: `Bearer ${authToken}` } : {}),
        ...(driverAssistanceContext ? {
          "X-Traivo-Assist-Driver-Id": driverAssistanceContext.driverId,
          "X-Traivo-Assist-Route-Id": driverAssistanceContext.routeId,
        } : {}),
        ...options?.headers,
      },
    });
  } catch {
    throw new ApiError(0, "", "NETWORK_ERROR");
  }
  // Ignore responses from a session that was cleared or replaced mid-request.
  if (generation !== sessionGeneration) throw new ApiError(409, "", "SESSION_CHANGED");
  if (!res.ok) {
    const body = await res.text();
    if ((res.status === 401 && path !== "/auth/login" && path !== "/auth/driver-link") || (res.status === 403 && path === "/auth/me")) {
      clearAuthenticatedSession();
      void Promise.resolve(sessionExpiredHandler?.()).catch(() => {});
    }
    let code: string | undefined;
    let requestId: string | undefined;
    try {
      const parsed = JSON.parse(body) as Record<string, unknown>;
      if (typeof parsed.code === "string") code = parsed.code;
      if (typeof parsed.requestId === "string") requestId = parsed.requestId;
    } catch {
      // Some endpoints return plain text. The body remains internal and is
      // intentionally not surfaced as an error message.
    }
    // A rejected login is not an expired authenticated session. Classify it
    // by endpoint/status, without displaying or parsing server error prose.
    if (path === "/auth/login") {
      if (res.status === 401) code = "INVALID_CREDENTIALS";
      if (res.status === 423) code = "ACCOUNT_LOCKED";
    }
    throw new ApiError(res.status, body, code, requestId);
  }
  return res.status === 204 ? undefined as T : res.json();
}

export interface Driver {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  organizationId: string;
  vehicleId: string | null;
}

export interface DriverAssistanceAssignment {
  driver: Driver;
  route: Route;
}

export interface Vehicle {
  id: string;
  name: string;
  licensePlate: string | null;
  type: string | null;
  capacityKg: number | null;
  capacityM3: number | null;
  organizationId: string;
}

export interface RouteWorkdayTimelineItem {
  type: "depot_start" | "driving" | "waiting" | "service" | "break" | "charging" | "return" | "depot_end";
  startAt: string;
  endAt: string;
  durationMin: number;
  stopId?: string;
  distanceKm?: number;
}

export interface RouteWorkdaySummary {
  shiftMin: number;
  nonReturnDrivingMin: number;
  serviceMin: number;
  waitingMin: number;
  breakMin: number;
  returnMin: number;
  /** Minutes added by the planning travel reserve, kept separate from raw driving. */
  travelReserveMin?: number;
  /** Minutes added by the planning stop reserve, kept separate from raw service. */
  stopReserveMin?: number;
  totalMin: number;
  marginMin: number;
  overtimeMin: number;
  shiftEndAt: string;
}

export interface RouteDepotEndpoint {
  address: string;
  latitude: number;
  longitude: number;
  verifiedAt: string;
}

export interface RouteDepotSnapshot {
  start: RouteDepotEndpoint;
  end: RouteDepotEndpoint;
}

export type RoutePlanningObjective = "balanced" | "shortest" | "geographic" | "areas_worktime" | "minimize_vehicles";

export interface RoutePlanningSummary {
  complete: boolean;
  objective: RoutePlanningObjective;
  travelReservePercent: number;
  stopReserveMin: number;
  mandatoryUnplannedStopIds: string[];
  usedPairValues: string[];
  unusedPairValues: Array<{ pairValue: string; reason: string }>;
  unplanned: Array<{ stopId: string; priority: 0 | 1 | 2; reason: string }>;
}

export interface RoutePlanningSnapshot {
  version: 1;
  objective: RoutePlanningObjective;
  travelReservePercent: number;
  stopReserveMin: number;
}

export interface Route {
  executionProjection?: {
    selectionRevision?: string;
    activeStopId?: string | null;
    selectionChangedAt?: string | null;
    etaUnavailableReason?: string | null;
  } | null;
  id: string;
  name: string;
  status: string;
  handoffDriverId: string | null;
  vehicleId: string | null;
  organizationId: string;
  date: string | null;
  optimizedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalDistanceKm: number | null;
  totalDurationMin: number | null;
  totalCo2Kg: number | null;
  handoffStatus: "pending" | "sent" | "received" | "opened" | "accepted" | "rejected";
  handoffVersion: number;
  planRevision: number;
  sentAt: string | null;
  receivedAt: string | null;
  openedAt: string | null;
  acceptedAt: string | null;
  rejectedAt: string | null;
  rejectionReason: string | null;
  depotSnapshot?: RouteDepotSnapshot | null;
  workdayTimeline?: RouteWorkdayTimelineItem[] | null;
  workdaySummary?: RouteWorkdaySummary | null;
  /** Optional route material copied from the assigned planning plan. */
  customerReference?: string | null;
  sharedInstructions?: string | null;
  planningSummary?: RoutePlanningSummary | null;
  optimizationPlanningSnapshot?: RoutePlanningSnapshot | null;
}

export interface RouteIncident {
  id: string;
  routeId: string;
  category: string;
  comment: string;
  attachmentUrl: string | null;
  createdAt: string;
}

export interface Stop {
  id: string;
  routeId: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  navigationVerified?: boolean;
  terminalAt?: string | null;
  navigationAddress?: string | null;
  arrival?: {
    plannedAt: string | null; estimatedAt: string | null; calculatedAt: string | null;
    positionAt: string | null; source: "road" | "plan_shift" | null;
  } | null;
  status: string;
  sequenceOrder: number | null;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  serviceDurationMin: number | null;
  notes: string | null;
  contactName: string | null;
  contactEmail: string | null;
  completedAt: string | null;
  pickupAddress: string | null;
  pickupLatitude: number | null;
  pickupLongitude: number | null;
  jobType?: string;
  priority?: number | null;
  slaDeadline?: string | null;
  serviceCategory?: string;
  serviceInstructions?: string;
  requiredSkills?: string[];
  requiredCertifications?: string[];
  requiredEquipment?: string[];
  customFields?: Record<string, string> | null;
}

export interface ServiceMaterial {
  itemCode?: string;
  description: string;
  quantity: number;
  unit?: string;
  unitCost?: number;
}

export interface ServiceReport {
  id?: string;
  stopId: string;
  status: "draft" | "submitted" | "billing_ready";
  startedAt?: string;
  completedAt?: string;
  actualDurationMin?: number;
  notes?: string;
  customerSignatoryName?: string;
  signatureEvidenceRef?: string;
}

export interface PutServiceReportPayload {
  driverId: string;
  status: "draft" | "submitted" | "billing_ready";
  startedAt?: string;
  completedAt?: string;
  actualDurationMin?: number;
  notes?: string;
  materials?: ServiceMaterial[];
  customerSignatoryName?: string;
  signatureEvidenceRef?: string;
}

export interface StopExecutionEventInput {
  clientEventId: string;
  type: "completed" | "failed" | "skipped" | "comment" | "actual_time" | "select_next";
  expectedSelectionRevision?: string;
  planVersion: number;
  occurredAt: string;
  skipReason?: string;
  comment?: string;
  actualDurationMin?: number;
}
export interface DriverPreferences {
  id: string;
  driverId: string;
  preferredStartTime: string | null;
  preferredEndTime: string | null;
  maxDrivingHours: number | null;
  avoidNightDriving: boolean;
}

export interface DriverStats {
  totalRoutes: number;
  completedRoutes: number;
  totalDeliveries: number;
  completedDeliveries: number;
  failedDeliveries: number;
  skippedDeliveries: number;
  onTimeRate: number | null;
  avgServiceDurationMin: number | null;
  totalDistanceKm: number | null;
  happinessScore: number | null;
}

export interface AuthUser {
  id: string;
  name: string;
  email: string;
  role: string;
  organizationId: string;
  driverProfileId: string | null;
}

export interface LoginResponse {
  user: AuthUser;
  token: string;
  session: { idleTimeoutMin: number; absoluteTimeoutHours: number; absoluteExpiresAt: string };
}

export interface RouteTrackingPosition {
  latitude: number;
  longitude: number;
  heading: number;
  speedKmh: number;
  accuracy?: number | null;
  recordedAt?: string;
}

export interface RouteTrackingSummary {
  sampleCount: number;
  distanceKm: number;
  durationMin: number | null;
  startedAt: string;
  endedAt: string | null;
  lastPosition: RouteTrackingPosition | null;
}

export interface RouteTrackingSession {
  routeId: string;
  sessionId: string;
  clientSessionId: string;
  status: "active" | "ended";
  startedAt: string;
  endedAt: string | null;
  summary: RouteTrackingSummary;
}

export interface RouteMessage {
  id: string;
  routeId: string;
  authorId: string;
  authorName: string;
  body: string;
  createdAt: string;
  clientMessageId: string | null;
}

export interface StopMessageReadReceipt {
  userId: string;
  readAt: string;
}

export interface StopMessage {
  id: string;
  threadId: string;
  stopId: string;
  senderUserId: string;
  senderRole: string;
  body: string;
  createdAt: string;
  clientMessageId: string;
  readAt: string | null;
  readReceipts: StopMessageReadReceipt[];
}

export interface StopMessagesResponse {
  thread: { id: string; stopId: string; routeId: string; driverId: string } | null;
  messages: StopMessage[];
}

export interface RouteMessagesResponse {
  messages: RouteMessage[];
  nextCursor: string | null;
}

export interface StopException {
  id: string;
  stopId: string;
  category: string;
  comment: string;
  attachmentUrl: string | null;
  proofStage: "pickup" | "delivery";
  createdAt: string;
}

export interface StalePlanResponse {
  error?: string;
  code?: string;
  currentPlanVersion?: number;
  itemId?: string;
  routeId?: string;
}

export const api = {
  login: (email: string, password: string) =>
    request<LoginResponse | { mfaRequired: true }>("/auth/login", {
      method: "POST",
      body: JSON.stringify({ email, password }),
    }),

  redeemDriverLink: (token: string) =>
    request<LoginResponse & { routeId: string; resumed?: boolean }>("/auth/driver-link", {
      method: "POST", body: JSON.stringify({ token }),
    }),

  verifyEmailCode: (code: string) =>
    request<LoginResponse>("/auth/mfa/verify", {
      method: "POST", body: JSON.stringify({ code }),
    }),

  resendEmailCode: () =>
    request<void>("/auth/mfa/resend", { method: "POST" }),

  me: () =>
    request<{ user: AuthUser; session: { idleTimeoutMin: number; absoluteTimeoutHours: number; absoluteExpiresAt: string } }>(
      "/auth/me",
    ),

  logout: () =>
    request<{ ok: boolean }>("/auth/logout", { method: "POST" }),

  requestPasswordReset: (email: string) =>
    request<{ ok: boolean }>("/auth/forgot-password", {
      method: "POST",
      body: JSON.stringify({ email: email.trim().toLowerCase() }),
    }),

  resetPassword: (token: string, password: string) =>
    request<{ ok: boolean }>("/auth/reset-password", {
      method: "POST",
      body: JSON.stringify({ token, password }),
    }),

  updateLocation: (
    vehicleId: string,
    latitude: number,
    longitude: number,
    heading: number,
    speedKmh: number,
    options: { routeId: string; clientSessionId: string; accuracy?: number; timestamp?: number },
  ) =>
    request<{ ok: boolean }>("/tracking/location", {
      method: "POST",
      body: JSON.stringify({
        vehicleId,
        latitude,
        longitude,
        heading,
        speedKmh,
        ...(options?.routeId ? { routeId: options.routeId } : {}),
        ...(options?.accuracy !== undefined ? { accuracy: options.accuracy } : {}),
        ...(options?.clientSessionId ? { clientSessionId: options.clientSessionId } : {}),
        ...(options?.timestamp !== undefined ? { timestamp: options.timestamp } : {}),
      }),
    }),

  startRouteTracking: (
    routeId: string,
    data: { action: "start" | "end"; clientSessionId: string; occurredAt?: string },
  ) =>
    request<RouteTrackingSession>(`/tracking/route-session`, {
      method: "POST",
      body: JSON.stringify({ routeId, ...data }),
    }),

  getRouteTrackingSession: (routeId: string) =>
    request<RouteTrackingSession | null>(`/tracking/route-session/${routeId}`),

  getRouteExecution: (routeId: string) =>
    request<RouteTrackingSession | null>(`/routes/${routeId}/execution`),

  executeRouteLifecycle: (routeId: string, action: "start" | "end", clientEventId: string, occurredAt = new Date().toISOString()) =>
    request<RouteTrackingSession>(`/routes/${routeId}/execution/${action}`, {
      method: "POST",
      body: JSON.stringify({ clientEventId, occurredAt }),
    }),

  registerPushToken: (driverId: string, expoPushToken: string) =>
    request<Driver>(`/drivers/${driverId}`, {
      method: "PUT",
      body: JSON.stringify({ expoPushToken }),
    }),

  getDrivers: () =>
    request<Driver[]>("/drivers"),

  getDriverAssistanceAssignments: () =>
    request<DriverAssistanceAssignment[]>("/driver-assistance"),

  getDriver: (id: string) =>
    request<Driver>(`/drivers/${id}`),

  // Only AuthContext uses this while /auth/me's assignment is being checked.
  verifyDriver: (id: string) =>
    request<Driver>(`/drivers/${id}`, undefined, true),

  getRoutes: (driverId?: string) => {
    let url = `/routes?${organizationQuery()}`;
    if (driverId) url += `&driverId=${encodeURIComponent(driverId)}`;
    return request<Route[]>(url);
  },

  getRoute: (id: string) =>
    request<Route>(`/routes/${id}`),

  getRouteStops: (routeId: string) =>
    request<Stop[]>(`/routes/${routeId}/stops`),

  updateRouteHandoff: (
    routeId: string,
    data: { status: "received" | "opened" | "accepted" | "rejected"; version: number; reason?: string },
  ) =>
    request<Route>(`/routes/${routeId}/handoff`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getRouteIncidents: (routeId: string) =>
    request<RouteIncident[]>(`/routes/${routeId}/incidents`),

  createRouteIncident: (
    routeId: string,
    data: { category: RouteIncidentCategory; comment: string; attachmentUrl?: string },
  ) =>
    request<RouteIncident>(`/routes/${routeId}/incidents`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getRouteMessages: (routeId: string, cursor?: string) =>
    request<RouteMessagesResponse>(
      `/routes/${routeId}/messages${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    ),

  createRouteMessage: (routeId: string, data: { body: string; clientMessageId: string }) =>
    request<RouteMessage>(`/routes/${routeId}/messages`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getStopMessages: (stopId: string, since?: string) =>
    request<StopMessagesResponse>(
      `/stops/${stopId}/messages${since ? `?since=${encodeURIComponent(since)}` : ""}`,
    ),

  createStopMessage: (stopId: string, data: { body: string; clientMessageId: string }) =>
    request<{ message: StopMessage; duplicate: boolean }>(`/stops/${stopId}/messages`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  markStopMessagesRead: (stopId: string, messageIds?: string[]) =>
    request<{ marked: number; stopId?: string }>(`/stops/${stopId}/messages/read`, {
      method: "POST",
      body: JSON.stringify(messageIds ? { messageIds } : {}),
    }),

  updateStop: (id: string, data: Partial<Stop>) =>
    request<Stop>(`/stops/${id}`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  getStop: (id: string) =>
    request<Stop>(`/stops/${id}`),

  getReportCategories: () =>
    request<{ revision: number; categories: Array<{ id: string; label: string; active: boolean }> }>("/org/report-categories"),
  createStopExecutionEvent: (id: string, data: StopExecutionEventInput) =>
    request<{ duplicate: boolean }>(`/stops/${id}/execution-events`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getDriverPreferences: (driverId: string) =>
    request<DriverPreferences>(`/drivers/${driverId}/preferences`),

  updateDriverPreferences: (driverId: string, data: Partial<DriverPreferences>) =>
    request<DriverPreferences>(`/drivers/${driverId}/preferences`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  getDriverStats: (driverId: string) =>
    request<DriverStats>(`/drivers/${driverId}/stats`),

  submitProof: (stopId: string, data: { proofType: string; proofStage: "pickup" | "delivery"; data: string; notes?: string; clientEventId?: string; planVersion?: number; occurredAt?: string }) =>
    request<{ id: string }>(`/stops/${stopId}/proof`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  createStopException: (
    stopId: string,
    data: {
      category: string;
      comment: string;
      proofStage: "pickup" | "delivery";
      photoData: string;
      clientEventId: string;
      planVersion: number;
      occurredAt: string;
    },
  ) =>
    request<StopException>(`/stops/${stopId}/exceptions`, {
      method: "POST",
      body: JSON.stringify(data),
    }),

  getStopProofs: (stopId: string) =>
    request<unknown[]>(`/stops/${stopId}/proofs`),

  getServiceReport: (stopId: string) =>
    request<{ report: ServiceReport | null; materials: ServiceMaterial[] }>(`/stops/${stopId}/service-report`),

  putServiceReport: (stopId: string, data: PutServiceReportPayload) =>
    request<ServiceReport>(`/stops/${stopId}/service-report`, {
      method: "PUT",
      body: JSON.stringify(data),
    }),

  getVehicles: () =>
    request<Vehicle[]>(`/vehicles?${organizationQuery()}`),

  getVehicle: (id: string) =>
    request<Vehicle>(`/vehicles/${id}`),
};

function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}

const routeGeometryCache = new Map<string, { latitude: number; longitude: number }[]>();

export type RouteGeometrySource = "road" | "fallback";

export interface RouteGeometryResult {
  coordinates: { latitude: number; longitude: number }[];
  source: RouteGeometrySource;
}

export function isValidRouteCoordinate(
  latitude: number | null | undefined,
  longitude: number | null | undefined,
): boolean {
  return (
    Number.isFinite(latitude) &&
    Number.isFinite(longitude) &&
    Math.abs(latitude ?? 0) > 0.0001 &&
    Math.abs(longitude ?? 0) > 0.0001 &&
    Math.abs(latitude ?? 0) <= 90 &&
    Math.abs(longitude ?? 0) <= 180
  );
}

export async function fetchRouteGeometry(
  waypoints: { latitude: number; longitude: number }[],
): Promise<RouteGeometryResult> {
  const validWaypoints = waypoints.filter((waypoint) =>
    isValidRouteCoordinate(waypoint.latitude, waypoint.longitude),
  );
  const fallback: RouteGeometryResult = {
    coordinates: validWaypoints,
    source: "fallback",
  };

  if (validWaypoints.length < 2) return fallback;

  const key = validWaypoints.map((w) => `${w.latitude.toFixed(5)},${w.longitude.toFixed(5)}`).join("|");
  if (routeGeometryCache.has(key)) {
    return { coordinates: routeGeometryCache.get(key)!, source: "road" };
  }

  const coords = validWaypoints.map((w) => `${w.longitude},${w.latitude}`).join(";");
  const url = `${BASE_URL}/osrm/route?coords=${encodeURIComponent(coords)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return fallback;
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.[0]) return fallback;
    const decoded = decodePolyline(data.routes[0].geometry);
    const result = decoded.map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
    routeGeometryCache.set(key, result);
    return { coordinates: result, source: "road" };
  } catch {
    return fallback;
  }
}

export type RouteIncidentCategory =
  | "traffic"
  | "vehicle_issue"
  | "accident"
  | "customer_unavailable"
  | "access_problem"
  | "weather"
  | "safety"
  | "other";
