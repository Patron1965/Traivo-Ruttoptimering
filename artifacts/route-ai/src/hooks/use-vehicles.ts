import { useQueryClient } from "@tanstack/react-query";
import {
  useListVehicles as useGeneratedListVehicles,
  useCreateVehicle as useGeneratedCreateVehicle,
  useUpdateVehicle as useGeneratedUpdateVehicle,
  useDeleteVehicle as useGeneratedDeleteVehicle,
  useReorderVehicles as useGeneratedReorderVehicles,
  type Vehicle,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { invalidateRouteQueries } from "@/lib/route-query-cache";

export function useVehicles() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useGeneratedListVehicles({ organizationId: organizationId! }, {
    query: { queryKey: ["/api/vehicles", organizationId], enabled: !!organizationId },
  });
}

export function useCreateVehicle() {
  const queryClient = useQueryClient();
  return useGeneratedCreateVehicle({
    mutation: {
      onSuccess: (vehicle) => {
        queryClient.setQueriesData<Vehicle[]>({ queryKey: ["/api/vehicles"] }, (current) => {
          if (!current || current.some((item) => item.id === vehicle.id)) return current;
          return [...current, vehicle];
        });
        queryClient.invalidateQueries({ queryKey: ["/api/vehicles"] });
        queryClient.invalidateQueries({ queryKey: ["/api/drivers"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

export function useUpdateVehicle() {
  const queryClient = useQueryClient();
  return useGeneratedUpdateVehicle({
    mutation: {
      onSuccess: (vehicle) => {
        queryClient.setQueriesData<Vehicle[]>({ queryKey: ["/api/vehicles"] }, (current) =>
          current?.map((item) => item.id === vehicle.id ? vehicle : item),
        );
        queryClient.invalidateQueries({ queryKey: ["/api/vehicles"] });
        queryClient.invalidateQueries({ queryKey: ["/api/drivers"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

export function useDeleteVehicle() {
  const queryClient = useQueryClient();
  return useGeneratedDeleteVehicle({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: ["/api/vehicles"] });
        queryClient.invalidateQueries({ queryKey: ["/api/drivers"] });
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}

export function useReorderVehicles() {
  const queryClient = useQueryClient();
  return useGeneratedReorderVehicles({
    mutation: {
      onSuccess: (vehicles) => {
        queryClient.setQueriesData<Vehicle[]>({ queryKey: ["/api/vehicles"] }, vehicles);
        void invalidateRouteQueries(queryClient);
      },
    },
  });
}
