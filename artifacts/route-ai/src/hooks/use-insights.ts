import { useGetInsights as useGeneratedGetInsights, getGetInsightsQueryKey } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";
import { useEffect } from "react";
import { useQueryClient } from "@tanstack/react-query";

export function useInsights(dashboardUpdatedAt?: number) {
  const queryClient = useQueryClient();
  const result = useGeneratedGetInsights({ organizationId: ORG_ID });

  useEffect(() => {
    if (dashboardUpdatedAt) {
      queryClient.invalidateQueries({ queryKey: getGetInsightsQueryKey({ organizationId: ORG_ID }) });
    }
  }, [dashboardUpdatedAt, queryClient]);

  return result;
}
