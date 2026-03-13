import {
  useGetVehiclePositions as useGeneratedGetVehiclePositions,
  getGetVehiclePositionsQueryKey,
  useGetGeofenceEvents as useGeneratedGetGeofenceEvents,
  getGetGeofenceEventsQueryKey,
} from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

export function useVehiclePositions() {
  const params = { organizationId: ORG_ID };
  return useGeneratedGetVehiclePositions(
    params,
    {
      query: {
        queryKey: getGetVehiclePositionsQueryKey(params),
        refetchInterval: 3000,
        staleTime: 1000,
      },
    }
  );
}

export function useGeofenceEvents(limit = 50) {
  const params = { organizationId: ORG_ID, limit };
  return useGeneratedGetGeofenceEvents(
    params,
    {
      query: {
        queryKey: getGetGeofenceEventsQueryKey(params),
        refetchInterval: 5000,
        staleTime: 2000,
      },
    }
  );
}
