import { useQueryClient } from "@tanstack/react-query";
import {
  useListDrivers as useGeneratedListDrivers,
  useCreateDriver as useGeneratedCreateDriver,
  useUpdateDriver as useGeneratedUpdateDriver,
  useDeleteDriver as useGeneratedDeleteDriver,
  type Driver,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { invalidateRouteQueries } from "@/lib/route-query-cache";

export function useDrivers() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useGeneratedListDrivers<Driver[]>({ organizationId: organizationId! }, {
    query: { queryKey: ["/api/drivers", organizationId], enabled: !!organizationId },
  });
}

export function useCreateDriver() {
  const queryClient = useQueryClient();
  return useGeneratedCreateDriver({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/drivers"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

export function useUpdateDriver() {
  const queryClient = useQueryClient();
  return useGeneratedUpdateDriver({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/drivers"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

export function useDeleteDriver() {
  const queryClient = useQueryClient();
  return useGeneratedDeleteDriver({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/drivers"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}
