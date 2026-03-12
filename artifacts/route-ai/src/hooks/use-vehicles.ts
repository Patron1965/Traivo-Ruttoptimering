import { useQueryClient } from "@tanstack/react-query";
import {
  useListVehicles as useGeneratedListVehicles,
  useCreateVehicle as useGeneratedCreateVehicle,
  useUpdateVehicle as useGeneratedUpdateVehicle,
  useDeleteVehicle as useGeneratedDeleteVehicle,
} from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

const VEHICLES_KEY = ["/api/vehicles", { organizationId: ORG_ID }];

export function useVehicles() {
  return useGeneratedListVehicles({ organizationId: ORG_ID });
}

export function useCreateVehicle() {
  const queryClient = useQueryClient();
  return useGeneratedCreateVehicle({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/vehicles"] }),
    },
  });
}

export function useUpdateVehicle() {
  const queryClient = useQueryClient();
  return useGeneratedUpdateVehicle({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/vehicles"] }),
    },
  });
}

export function useDeleteVehicle() {
  const queryClient = useQueryClient();
  return useGeneratedDeleteVehicle({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/vehicles"] }),
    },
  });
}
