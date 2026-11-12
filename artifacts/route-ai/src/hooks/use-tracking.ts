import { useEffect, useRef, useCallback, useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetVehiclePositions as useGeneratedGetVehiclePositions,
  getGetVehiclePositionsQueryKey,
  useGetGeofenceEvents as useGeneratedGetGeofenceEvents,
  getGetGeofenceEventsQueryKey,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { onWsMessage, isWsConnected } from "@/lib/ws-client";

export function useVehiclePositions(enabled = true) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const params = useMemo(() => ({ organizationId: organizationId! }), [organizationId]);
  const [wsActive, setWsActive] = useState(false);
  const wsCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    if (!organizationId || !enabled) return;

    const unsub = onWsMessage("vehicles:positions", (data) => {
      queryClient.setQueryData(getGetVehiclePositionsQueryKey(params), data);
      setWsActive(true);
    });

    wsCheckRef.current = setInterval(() => {
      setWsActive(isWsConnected());
    }, 5000);

    return () => {
      unsub();
      if (wsCheckRef.current) clearInterval(wsCheckRef.current);
    };
  }, [organizationId, params, queryClient, enabled]);

  return useGeneratedGetVehiclePositions(params, {
    query: {
      queryKey: getGetVehiclePositionsQueryKey(params),
      enabled: !!organizationId && enabled,
      refetchInterval: wsActive ? false : 3000,
      staleTime: wsActive ? 10000 : 1000,
    },
  });
}

export function useGeofenceEvents(limit = 50, enabled = true) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const params = useMemo(() => ({ organizationId: organizationId!, limit }), [organizationId, limit]);

  useEffect(() => {
    if (!organizationId || !enabled) return;

    const unsubStop = onWsMessage("stop:completed", () => {
      queryClient.invalidateQueries({
        queryKey: getGetGeofenceEventsQueryKey(params),
      });
    });

    const unsubRoute = onWsMessage("route:status", () => {
      queryClient.invalidateQueries({
        queryKey: getGetGeofenceEventsQueryKey(params),
      });
    });

    return () => {
      unsubStop();
      unsubRoute();
    };
  }, [organizationId, params, queryClient, enabled]);

  return useGeneratedGetGeofenceEvents(params, {
    query: {
      queryKey: getGetGeofenceEventsQueryKey(params),
      enabled: !!organizationId && enabled,
      refetchInterval: 5000,
      staleTime: 2000,
    },
  });
}
