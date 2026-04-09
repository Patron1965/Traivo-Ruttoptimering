import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { onWsMessage, initWsClient } from "@/lib/ws-client";
import { ORG_ID } from "@/lib/constants";

const ENTITY_QUERY_KEY_MAP: Record<string, string[][]> = {
  route: [["/api/routes"], ["/api/dashboard/stats"]],
  vehicle: [["/api/vehicles"]],
  stop: [["/api/stops"], ["/api/dashboard/stats"]],
  driver: [["/api/drivers"]],
};

export function useRealtimeSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    initWsClient(ORG_ID);

    const handleChange = (type: string) => (data: unknown) => {
      const parsed = data as { entity?: string; id?: string; bulk?: boolean };
      const entity = parsed.entity ?? type;
      const queryKeys = ENTITY_QUERY_KEY_MAP[entity];
      if (!queryKeys) return;

      for (const key of queryKeys) {
        queryClient.invalidateQueries({ queryKey: key });
      }

      if (entity === "route") {
        queryClient.invalidateQueries({ queryKey: ["routes"] });
        queryClient.invalidateQueries({ queryKey: ["getRoutes"] });
      }
    };

    const unsubs = [
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
      onWsMessage("routes:reoptimized", handleChange("route")),
    ];

    return () => {
      for (const unsub of unsubs) unsub();
    };
  }, [queryClient]);
}
