import { useEffect, useRef, useCallback, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  useGetVehiclePositions as useGeneratedGetVehiclePositions,
  getGetVehiclePositionsQueryKey,
  useGetGeofenceEvents as useGeneratedGetGeofenceEvents,
  getGetGeofenceEventsQueryKey,
} from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";
import { onWsMessage, isWsConnected } from "@/lib/ws-client";

export function useVehiclePositions() {
  const queryClient = useQueryClient();
  const params = { organizationId: ORG_ID };
  const [wsActive, setWsActive] = useState(false);
  const wsCheckRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const unsub = onWsMessage("vehicles:positions", (data) => {
      queryClient.setQueryData(getGetVehiclePositionsQueryKey(params), data);
      if (!wsActive) setWsActive(true);
    });

    wsCheckRef.current = setInterval(() => {
      setWsActive(isWsConnected());
    }, 5000);

    return () => {
      unsub();
      if (wsCheckRef.current) clearInterval(wsCheckRef.current);
    };
  }, [queryClient]);

  return useGeneratedGetVehiclePositions(params, {
    query: {
      queryKey: getGetVehiclePositionsQueryKey(params),
      refetchInterval: wsActive ? false : 3000,
      staleTime: wsActive ? 10000 : 1000,
    },
  });
}

export function useGeofenceEvents(limit = 50) {
  const queryClient = useQueryClient();
  const params = { organizationId: ORG_ID, limit };

  useEffect(() => {
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
  }, [queryClient]);

  return useGeneratedGetGeofenceEvents(params, {
    query: {
      queryKey: getGetGeofenceEventsQueryKey(params),
      refetchInterval: 5000,
      staleTime: 2000,
    },
  });
}
