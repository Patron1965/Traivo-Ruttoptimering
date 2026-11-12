import AsyncStorage from "./environment-storage";
import * as Location from "expo-location";
import * as TaskManager from "expo-task-manager";
import { Platform } from "react-native";
import { getApiBaseUrl } from "./api";
import { shouldInvalidateGpsForHttpStatus } from "./mobile-invariants";
import { type AppLanguage } from "./error-localizer";
import {
  parsePersistedGpsError,
  toPersistedGpsError,
  type GpsErrorValue,
  type PersistedGpsError,
} from "./gps-errors";

export const GPS_TASK_NAME = "traivo-route-background-gps";
export const GPS_SESSION_KEY = "traivo_route_gps_session";
export const GPS_LAST_POSITION_KEY = "traivo_route_gps_last_position";
export const GPS_ERROR_KEY = "traivo_route_gps_error";
const TOKEN_KEY = "routeai_token";
const LANGUAGE_KEY = "routeai-lang";

export interface PersistedGpsSession {
  routeId: string;
  vehicleId: string;
  clientSessionId: string;
  userId: string;
  organizationId: string;
  startedAt: string;
  status: "active" | "ended";
}

export interface PersistedGpsPosition {
  latitude: number;
  longitude: number;
  heading: number;
  speedKmh: number;
  accuracy: number | null;
  recordedAt: string;
}

export type GpsEvent =
  | { type: "state"; session: PersistedGpsSession | null }
  | { type: "position"; position: PersistedGpsPosition }
  | { type: "cleared" }
  | { type: "error"; error: PersistedGpsError };

const listeners = new Set<(event: GpsEvent) => void>();

export function subscribeGpsEvents(listener: (event: GpsEvent) => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(event: GpsEvent) {
  listeners.forEach((listener) => listener(event));
}

export async function getPersistedGpsSession(): Promise<PersistedGpsSession | null> {
  const raw = await AsyncStorage.getItem(GPS_SESSION_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as PersistedGpsSession;
    return parsed.status === "active" && parsed.routeId && parsed.vehicleId
      ? parsed
      : null;
  } catch {
    await AsyncStorage.removeItem(GPS_SESSION_KEY);
    return null;
  }
}

export async function getLastGpsPosition(): Promise<PersistedGpsPosition | null> {
  const raw = await AsyncStorage.getItem(GPS_LAST_POSITION_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as PersistedGpsPosition;
  } catch {
    await AsyncStorage.removeItem(GPS_LAST_POSITION_KEY);
    return null;
  }
}

export async function getGpsError(): Promise<GpsErrorValue | null> {
  const raw = await AsyncStorage.getItem(GPS_ERROR_KEY);
  return raw ? parsePersistedGpsError(raw) : null;
}

class BackgroundGpsHttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "BackgroundGpsHttpError";
  }
}

async function storedLanguage(): Promise<AppLanguage> {
  const saved = await AsyncStorage.getItem(LANGUAGE_KEY);
  return saved === "en" ? "en" : "sv";
}

async function persistPosition(position: PersistedGpsPosition) {
  await AsyncStorage.setItem(GPS_LAST_POSITION_KEY, JSON.stringify(position));
  await AsyncStorage.removeItem(GPS_ERROR_KEY);
  publish({ type: "position", position });
}

async function postBackgroundPosition(
  session: PersistedGpsSession,
  location: Location.LocationObject,
) {
  const token = await AsyncStorage.getItem(TOKEN_KEY);
  if (!token) throw new BackgroundGpsHttpError(401, "GPS session is not authenticated");
  const response = await fetch(`${getApiBaseUrl()}/tracking/location`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      vehicleId: session.vehicleId,
      routeId: session.routeId,
      clientSessionId: session.clientSessionId,
      latitude: location.coords.latitude,
      longitude: location.coords.longitude,
      heading: location.coords.heading ?? 0,
      speedKmh: Math.max(0, (location.coords.speed ?? 0) * 3.6),
      accuracy: location.coords.accuracy ?? undefined,
      timestamp: location.timestamp,
    }),
  });
  if (!response.ok) {
    // Keep backend response details out of the persisted/background error.
    throw new BackgroundGpsHttpError(response.status, "GPS position could not be sent");
  }
  await persistPosition({
    latitude: location.coords.latitude,
    longitude: location.coords.longitude,
    heading: location.coords.heading ?? 0,
    speedKmh: Math.max(0, (location.coords.speed ?? 0) * 3.6),
    accuracy: location.coords.accuracy ?? null,
    recordedAt: new Date(location.timestamp).toISOString(),
  });
}

// Expo evaluates this module in the background task's isolated JS runtime.
// Reading the persisted session and token here prevents telemetry from being
// sent after logout or after an explicit route end.
if (Platform.OS !== "web") {
  TaskManager.defineTask(GPS_TASK_NAME, async ({ data, error }: any) => {
    if (error) {
      const descriptor = toPersistedGpsError(error, "gpsUnavailable");
      await stopBackgroundGps().catch(() => {});
      await AsyncStorage.setItem(GPS_ERROR_KEY, JSON.stringify(descriptor));
      publish({ type: "error", error: descriptor });
      return;
    }
    const session = await getPersistedGpsSession();
    if (!session || session.status !== "active") {
      await stopBackgroundGps().catch(() => {});
      return;
    }
    const locations = (data?.locations ?? []) as Location.LocationObject[];
    let invalidated = false;
    for (const location of locations) {
      if (invalidated) break;
      try {
        await postBackgroundPosition(session, location);
      } catch (taskError) {
        if (
          taskError instanceof BackgroundGpsHttpError &&
          shouldInvalidateGpsForHttpStatus(taskError.status)
        ) {
          await stopBackgroundGps().catch(() => {});
          invalidated = true;
        }
        const descriptor = toPersistedGpsError(taskError);
        await AsyncStorage.setItem(GPS_ERROR_KEY, JSON.stringify(descriptor));
        publish({ type: "error", error: descriptor });
      }
    }
  });
}

export async function startBackgroundGps(session: PersistedGpsSession) {
  await AsyncStorage.setItem(GPS_SESSION_KEY, JSON.stringify(session));
  publish({ type: "state", session });
  if (Platform.OS === "web") return;
  const language = await storedLanguage();
  await Location.startLocationUpdatesAsync(GPS_TASK_NAME, {
    accuracy: Location.Accuracy.BestForNavigation,
    distanceInterval: 25,
    timeInterval: 5000,
    pausesUpdatesAutomatically: false,
    showsBackgroundLocationIndicator: true,
    foregroundService: {
      notificationTitle: "Traivo Route",
      notificationBody: language === "sv" ? "Aktiv rutt spåras" : "Active route is being tracked",
      notificationColor: "#2563EB",
    },
  });
}

export async function stopBackgroundGps() {
  let stopError: unknown;
  try {
    if (Platform.OS !== "web") {
      const started = await Location.hasStartedLocationUpdatesAsync(GPS_TASK_NAME);
      if (started) await Location.stopLocationUpdatesAsync(GPS_TASK_NAME);
    }
  } catch (error) {
    stopError = error;
  } finally {
    // Persisted state is cleared even when the native OS rejects the stop
    // call. The task checks this state before every upload, so auth/session
    // invalidation cannot continue collecting fixes.
    await AsyncStorage.removeItem(GPS_SESSION_KEY);
    await AsyncStorage.removeItem(GPS_LAST_POSITION_KEY);
    await AsyncStorage.removeItem(GPS_ERROR_KEY);
    publish({ type: "state", session: null });
    publish({ type: "cleared" });
  }
  if (stopError) throw stopError;
}