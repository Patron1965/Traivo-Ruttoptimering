import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onWsMessage, initWsClient, resetWsClient } from "@/lib/ws-client";
import { useAuth } from "@/lib/auth-context";
import { getGetRouteAcknowledgementQueryKey } from "@workspace/api-client-react";
import { invalidateRouteQueries } from "@/lib/route-query-cache";

const ENTITY_QUERY_KEY_MAP: Record<string, string[][]> = {
  route: [["/api/routes"], ["/api/dashboard/stats"]],
  vehicle: [["/api/vehicles"]],
  stop: [["/api/stops"], ["/api/dashboard/stats"]],
  driver: [["/api/drivers"]],
  policy: [["/api/org-settings"]],
  certification: [["/api/drivers"]],
};

export function useRealtimeSync() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const organizationId = user?.organizationId;

  useEffect(() => {
    if (!organizationId) return;
    initWsClient(organizationId);

    const handleChange = (type: string) => (data: unknown) => {
      const parsed = data as {
        entity?: string;
        id?: string;
        routeId?: string;
        routeIds?: string[];
        bulk?: boolean;
      };
      const entity = parsed.entity ?? type;
      const queryKeys = ENTITY_QUERY_KEY_MAP[entity];
      if (!queryKeys) return;

      for (const key of queryKeys) {
        queryClient.invalidateQueries({ queryKey: key });
      }

      if (entity === "route") {
        queryClient.invalidateQueries({ queryKey: ["routes"] });
        queryClient.invalidateQueries({ queryKey: ["getRoutes"] });
        const routeIds = parsed.id ? [parsed.id] : (parsed.routeIds ?? []);
        void invalidateRouteQueries(queryClient, routeIds);
        for (const routeId of routeIds) {
          queryClient.invalidateQueries({
            queryKey: getGetRouteAcknowledgementQueryKey(routeId),
          });
        }
      } else if (
        entity === "stop" ||
        entity === "vehicle" ||
        entity === "driver" ||
        entity === "policy" ||
        entity === "certification"
      ) {
        // Resource/policy/certification edits clear derived overlap evidence
        // without changing route revisions. Realtime list invalidation alone
        // does not match generated `/api/routes/:id` detail keys.
        const routeIds = parsed.routeIds ??
          (parsed.routeId ? [parsed.routeId] : undefined);
        void invalidateRouteQueries(queryClient, routeIds);
      }
    };

    const unsubs = [
      // A reconnect can have missed events. Rehydrate tenant-scoped server
      // state immediately after every successful subscription.
      onWsMessage("subscribed", () => {
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
        void invalidateRouteQueries(queryClient);
      }),
      onWsMessage("data:route:created", handleChange("route")),
      onWsMessage("data:route:updated", handleChange("route")),
      onWsMessage("data:route:deleted", handleChange("route")),
      onWsMessage("data:vehicle:created", handleChange("vehicle")),
      onWsMessage("data:vehicle:updated", handleChange("vehicle")),
      onWsMessage("data:vehicle:deleted", handleChange("vehicle")),
      onWsMessage("data:stop:created", handleChange("stop")),
      onWsMessage("data:stop:updated", handleChange("stop")),
      onWsMessage("data:stop:deleted", handleChange("stop")),
      onWsMessage("data:driver:created", handleChange("driver")),
      onWsMessage("data:driver:updated", handleChange("driver")),
      onWsMessage("data:driver:deleted", handleChange("driver")),
      onWsMessage("data:policy:updated", handleChange("policy")),
      onWsMessage("data:certification:created", handleChange("certification")),
      onWsMessage("data:certification:updated", handleChange("certification")),
      onWsMessage("data:certification:deleted", handleChange("certification")),
      onWsMessage("routes:reoptimized", handleChange("route")),
      onWsMessage("execution:event", (data) => {
        const event = data as { stopId?: string; routeId?: string };
        queryClient.invalidateQueries({ queryKey: ["/api/stops"] });
        queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
        queryClient.invalidateQueries({ queryKey: ["/api/dashboard/stats"] });
        if (event.stopId) {
          queryClient.invalidateQueries({ queryKey: [`/api/stops/${event.stopId}`] });
          queryClient.invalidateQueries({ queryKey: [`/api/stops/${event.stopId}/proofs`] });
          queryClient.invalidateQueries({ queryKey: ["proofs", organizationId, event.stopId] });
        }
        if (event.routeId) {
          void invalidateRouteQueries(queryClient, [event.routeId]);
          queryClient.invalidateQueries({ queryKey: [`/api/routes/${event.routeId}`] });
          queryClient.invalidateQueries({ queryKey: [`/api/routes/${event.routeId}/stops`] });
          queryClient.invalidateQueries({ queryKey: ["route-proofs", organizationId, event.routeId] });
        }
      }),
      onWsMessage("execution:redistribution-approved", handleChange("route")),
    ];

    return () => {
      for (const unsub of unsubs) unsub();
      resetWsClient(organizationId);
    };
  }, [organizationId, queryClient]);
}
