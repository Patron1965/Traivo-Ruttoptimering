import { useQueryClient } from "@tanstack/react-query";
import {
  useListDrivers as useGeneratedListDrivers,
  useCreateDriver as useGeneratedCreateDriver,
  useUpdateDriver as useGeneratedUpdateDriver,
  useDeleteDriver as useGeneratedDeleteDriver,
} from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

export function useDrivers() {
  return useGeneratedListDrivers({ organizationId: ORG_ID });
}

export function useCreateDriver() {
  const queryClient = useQueryClient();
  return useGeneratedCreateDriver({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/drivers"] }),
    },
  });
}

export function useUpdateDriver() {
  const queryClient = useQueryClient();
  return useGeneratedUpdateDriver({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/drivers"] }),
    },
  });
}

export function useDeleteDriver() {
  const queryClient = useQueryClient();
  return useGeneratedDeleteDriver({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/drivers"] }),
    },
  });
}
