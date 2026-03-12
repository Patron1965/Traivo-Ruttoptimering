import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  useGetVehiclePositions as useGeneratedGetVehiclePositions,
  useGetGeofenceEvents as useGeneratedGetGeofenceEvents,
} from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

export function useVehiclePositions() {
  return useGeneratedGetVehiclePositions(
    { organizationId: ORG_ID },
    {
      query: {
        refetchInterval: 3000,
        staleTime: 1000,
      },
    }
  );
}

export function useGeofenceEvents(limit = 50) {
  return useGeneratedGetGeofenceEvents(
    { organizationId: ORG_ID, limit },
    {
      query: {
        refetchInterval: 5000,
        staleTime: 2000,
      },
    }
  );
}
