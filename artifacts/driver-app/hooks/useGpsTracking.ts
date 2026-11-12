import { useCallback, useEffect, useRef, useState } from "react";
import * as Location from "expo-location";
import { Platform } from "react-native";
import { api, type RouteTrackingSession } from "@/lib/api";
import {
  getLastGpsPosition,
  getGpsError,
  getPersistedGpsSession,
  startBackgroundGps,
  stopBackgroundGps,
  subscribeGpsEvents,
  type PersistedGpsPosition,
  type PersistedGpsSession,
} from "@/lib/gps-task";
import { shouldInvalidateGpsForHttpStatus } from "@/lib/mobile-invariants";
import { createAppError, localizeError } from "@/lib/error-localizer";
import { useT } from "@/lib/i18n";
import { finishTrackingSession, trackingStartIdentity } from "@/lib/tracking-lifecycle";

export interface GpsTrackingState {
  session: PersistedGpsSession | null;
  lastPosition: PersistedGpsPosition | null;
  error: string | null;
  isStarting: boolean;
  isEnding: boolean;
}

function createClientSessionId() {
  return `gps_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function startRouteTracking(
  routeId: string,
  vehicleId: string,
  owner: { userId: string; organizationId: string },
): Promise<RouteTrackingSession> {
  if (Platform.OS !== "web") {
    const foreground = await Location.requestForegroundPermissionsAsync();
    if (foreground.status !== "granted") {
      throw createAppError("gpsPermission");
    }
    const background = await Location.requestBackgroundPermissionsAsync();
    if (background.status !== "granted") {
      throw createAppError("gpsBackgroundPermission");
    }
  }

  // Recover the server's current session after an app restart or GPS failure.
  // POST start still validates the current recipient and accepted revision.
  const existing = await api.getRouteTrackingSession(routeId);
  const identity = trackingStartIdentity(existing, createClientSessionId);
  const { clientSessionId } = identity;
  const started = await api.startRouteTracking(routeId, {
    action: "start",
    ...identity,
  });
  if (started.status !== "active") throw createAppError("conflict");
  try {
    await startBackgroundGps({
      routeId,
      vehicleId,
      clientSessionId,
      userId: owner.userId,
      organizationId: owner.organizationId,
      startedAt: started.startedAt || new Date().toISOString(),
      status: "active",
    });
  } catch (startError) {
    // A device GPS failure is not completion of the route. The next start
    // recovers the active server session through the guarded start endpoint.
    await stopBackgroundGps().catch(() => {});
    throw startError;
  }
  return started;
}

export async function endRouteTracking(routeId: string, session: PersistedGpsSession | null) {
  if (!session || session.routeId !== routeId) return null;
  return finishTrackingSession(
    () => api.startRouteTracking(routeId, {
      action: "end",
      clientSessionId: session.clientSessionId,
    }),
    stopBackgroundGps,
  );
}

export function useGpsTracking(
  routeId: string | null | undefined,
  vehicleId: string | null | undefined,
  accepted: boolean,
  owner: { userId: string; organizationId: string } | null | undefined,
): GpsTrackingState & {
  start: () => Promise<RouteTrackingSession>;
  end: () => Promise<RouteTrackingSession | null>;
  clearError: () => void;
} {
  const [session, setSession] = useState<PersistedGpsSession | null>(null);
  const [lastPosition, setLastPosition] = useState<PersistedGpsPosition | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isStarting, setIsStarting] = useState(false);
  const [isEnding, setIsEnding] = useState(false);
  const webWatchRef = useRef<number | null>(null);
  const [hydratedScope, setHydratedScope] = useState<string | null>(null);
  const scope = `${owner?.organizationId}:${owner?.userId}:${routeId}`;
  const { lang, t } = useT();
  const setLocalizedError = useCallback(
    (nextError: unknown, fallback = t("errors.generic")) => {
      setError(localizeError(nextError, lang, { fallback }));
    },
    [lang, t],
  );

  useEffect(() => {
    let mounted = true;
    Promise.all([getPersistedGpsSession(), getLastGpsPosition(), getGpsError()]).then(([storedSession, storedPosition, storedError]) => {
      if (!mounted) return;
      const ownsStoredSession = Boolean(
        storedSession &&
        owner &&
        storedSession.routeId === routeId &&
        storedSession.userId === owner.userId &&
        storedSession.organizationId === owner.organizationId,
      );
      if (storedSession && !ownsStoredSession) {
        void stopBackgroundGps().catch((stopError) => {
          if (mounted) setLocalizedError(stopError);
        });
      }
      setSession(ownsStoredSession ? storedSession : null);
      setLastPosition(ownsStoredSession ? storedPosition : null);
      if (storedError && ownsStoredSession) setLocalizedError(storedError);
      if (!ownsStoredSession) setError(null);
      setHydratedScope(scope);
    }).catch((loadError) => {
      if (mounted) setLocalizedError(loadError);
    });

    const unsubscribe = subscribeGpsEvents((event) => {
      if (!mounted) return;
      if (event.type === "state") {
        setSession(event.session?.routeId === routeId ? event.session : null);
      } else if (event.type === "position") {
        setLastPosition(event.position);
      } else if (event.type === "cleared") {
        setLastPosition(null);
      } else {
        setLocalizedError(event.error);
      }
    });
    return () => {
      mounted = false;
      unsubscribe();
    };
  }, [owner, routeId, scope, setLocalizedError]);

  // Starting service work and starting telemetry are separate server actions.
  // Resume telemetry only for an already active, accepted execution, never
  // merely because a route has been opened or assigned.
  useEffect(() => {
    if (hydratedScope !== scope || session || error || isStarting || !accepted || !routeId || !vehicleId || !owner) return;
    let cancelled = false;
    let busy = false;
    const resume = async () => {
      if (busy || cancelled) return;
      busy = true;
      try {
        const execution = await api.getRouteTrackingSession(routeId);
        if (!cancelled && execution?.status === "active") {
          await startRouteTracking(routeId, vehicleId, owner);
        }
      } catch (resumeError) {
        if (!cancelled) setLocalizedError(resumeError);
      } finally {
        busy = false;
      }
    };
    void resume();
    const timer = setInterval(() => void resume(), 10000);
    return () => { cancelled = true; clearInterval(timer); };
  }, [hydratedScope, scope, session, error, isStarting, accepted, routeId, vehicleId, owner, setLocalizedError]);

  useEffect(() => {
    if (!session || lastPosition) return;
    const timer = setTimeout(() => {
      setLocalizedError(createAppError("gpsUnavailable"), t("errors.gpsUnavailable"));
    }, 15000);
    return () => clearTimeout(timer);
  }, [lastPosition, session, setLocalizedError, t]);

  useEffect(() => {
    if (!session) return;
    const timer = setInterval(() => {
      void getLastGpsPosition().then((position) => {
        if (position) setLastPosition(position);
      });
    }, 3000);
    return () => clearInterval(timer);
  }, [session]);

  useEffect(() => {
    if (!session || !accepted || !routeId || !vehicleId) {
      if (session && !accepted && routeId) {
        void stopBackgroundGps().catch((endError) => {
          setLocalizedError(endError);
        });
      }
      if (webWatchRef.current !== null && typeof navigator !== "undefined") {
        navigator.geolocation?.clearWatch(webWatchRef.current);
        webWatchRef.current = null;
      }
      return;
    }

    const sendLocation = async (location: Location.LocationObject) => {
      try {
        await api.updateLocation(
          vehicleId,
          location.coords.latitude,
          location.coords.longitude,
          location.coords.heading ?? 0,
          Math.max(0, (location.coords.speed ?? 0) * 3.6),
          {
            routeId,
            clientSessionId: session.clientSessionId,
            accuracy: location.coords.accuracy ?? undefined,
            timestamp: location.timestamp,
          },
        );
        setError(null);
        setLastPosition({
          latitude: location.coords.latitude,
          longitude: location.coords.longitude,
          heading: location.coords.heading ?? 0,
          speedKmh: Math.max(0, (location.coords.speed ?? 0) * 3.6),
          accuracy: location.coords.accuracy ?? null,
          recordedAt: new Date(location.timestamp).toISOString(),
        });
      } catch (trackingError) {
        const status = (trackingError as { status?: number })?.status;
        if (status !== undefined && shouldInvalidateGpsForHttpStatus(status)) {
          await stopBackgroundGps().catch(() => {});
          if (webWatchRef.current !== null && typeof navigator !== "undefined") {
            navigator.geolocation?.clearWatch(webWatchRef.current);
            webWatchRef.current = null;
          }
        }
        setLocalizedError(trackingError);
      }
    };

    if (Platform.OS === "web") {
      if (typeof navigator !== "undefined" && navigator.geolocation) {
        webWatchRef.current = navigator.geolocation.watchPosition(
          (position) => void sendLocation({
            coords: {
              latitude: position.coords.latitude,
              longitude: position.coords.longitude,
              altitude: position.coords.altitude,
              accuracy: position.coords.accuracy,
              heading: position.coords.heading,
              speed: position.coords.speed,
              altitudeAccuracy: position.coords.altitudeAccuracy,
            },
            timestamp: position.timestamp,
          } as Location.LocationObject),
          (geoError) => {
            setLocalizedError(
              createAppError(geoError.code === 1 ? "gpsPermission" : "gpsUnavailable"),
            );
            if (geoError.code === 1) {
              void stopBackgroundGps().catch(() => {});
              if (webWatchRef.current !== null) {
                navigator.geolocation?.clearWatch(webWatchRef.current);
                webWatchRef.current = null;
              }
            }
          },
          { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 },
        );
      }
    }

    return () => {
      if (webWatchRef.current !== null && typeof navigator !== "undefined") {
        navigator.geolocation?.clearWatch(webWatchRef.current);
        webWatchRef.current = null;
      }
    };
  }, [accepted, owner?.organizationId, owner?.userId, routeId, vehicleId, session, setLocalizedError]);

  const start = useCallback(async () => {
    if (!routeId || !vehicleId || !accepted || !owner) {
      throw createAppError("validation");
    }
    setIsStarting(true);
    setError(null);
    try {
      return await startRouteTracking(routeId, vehicleId, owner);
    } catch (startError) {
      setLocalizedError(startError);
      throw startError;
    } finally {
      setIsStarting(false);
    }
  }, [accepted, owner, routeId, vehicleId, setLocalizedError]);

  const end = useCallback(async () => {
    if (!routeId || !session) return null;
    setIsEnding(true);
    setError(null);
    try {
      return await endRouteTracking(routeId, session);
    } catch (endError) {
      setLocalizedError(endError);
      throw endError;
    } finally {
      setIsEnding(false);
    }
  }, [routeId, session, setLocalizedError]);

  return {
    session,
    lastPosition,
    error,
    isStarting,
    isEnding,
    start,
    end,
    clearError: () => setError(null),
  };
}