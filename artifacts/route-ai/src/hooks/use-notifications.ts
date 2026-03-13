import { useQueryClient } from "@tanstack/react-query";
import {
  useGetNotifications as useGeneratedGetNotifications,
  getGetNotificationsQueryKey,
  useMarkNotificationRead as useGeneratedMarkNotificationRead,
  useMarkAllNotificationsRead as useGeneratedMarkAllNotificationsRead,
} from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

export function useNotifications() {
  const params = { organizationId: ORG_ID };
  return useGeneratedGetNotifications(
    params,
    {
      query: {
        queryKey: getGetNotificationsQueryKey(params),
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
