import { useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import {
  useGetNotifications as useGeneratedGetNotifications,
  getGetNotificationsQueryKey,
  useMarkNotificationRead as useGeneratedMarkNotificationRead,
  useMarkAllNotificationsRead as useGeneratedMarkAllNotificationsRead,
} from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";

export function useNotifications() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const params = useMemo(() => ({ organizationId: organizationId! }), [organizationId]);
  return useGeneratedGetNotifications(
    params,
    {
      query: {
        queryKey: getGetNotificationsQueryKey(params),
        enabled: !!organizationId,
        refetchInterval: 10000,
        staleTime: 5000,
      },
    }
  );
}

export function useMarkNotificationRead() {
  const queryClient = useQueryClient();
  return useGeneratedMarkNotificationRead({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
    },
  });
}

export function useMarkAllNotificationsRead() {
  const queryClient = useQueryClient();
  return useGeneratedMarkAllNotificationsRead({
    mutation: {
      onSuccess: () => queryClient.invalidateQueries({ queryKey: ["/api/notifications"] }),
    },
  });
}
