import { useQueryClient } from "@tanstack/react-query";
import {
  useListStops as useGeneratedListStops,
  useCreateStop as useGeneratedCreateStop,
  useUpdateStop as useGeneratedUpdateStop,
  useDeleteStop as useGeneratedDeleteStop,
} from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

export function useStops(routeId?: string) {
  return useGeneratedListStops(
    routeId ? { organizationId: ORG_ID, routeId } : { organizationId: ORG_ID }
  );
}

export function useCreateStop() {
  const queryClient = useQueryClient();
  return useGeneratedCreateStop({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
    },
  });
}

export function useUpdateStop() {
  const queryClient = useQueryClient();
  return useGeneratedUpdateStop({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
    },
  });
}

export function useDeleteStop() {
  const queryClient = useQueryClient();
  return useGeneratedDeleteStop({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/stops"] }),
    },
  });
}
