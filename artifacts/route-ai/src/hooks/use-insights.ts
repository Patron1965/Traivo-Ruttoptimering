import { useGetInsights as useGeneratedGetInsights, getGetInsightsQueryKey } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";
import { useEffect, useMemo } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useInsights(dashboardUpdatedAt?: number) {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  const params = useMemo(() => ({ organizationId: organizationId! }), [organizationId]);
  const result = useGeneratedGetInsights(params, {
    query: { queryKey: ["/api/insights", organizationId], enabled: !!organizationId },
  });

  useEffect(() => {
    if (dashboardUpdatedAt && organizationId) {
      queryClient.invalidateQueries({ queryKey: getGetInsightsQueryKey(params) });
    }
  }, [dashboardUpdatedAt, organizationId, params, queryClient]);

  return result;
}
