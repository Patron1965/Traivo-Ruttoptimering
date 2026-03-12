import { useGetInsights as useGeneratedGetInsights } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

export function useInsights() {
  return useGeneratedGetInsights({ organizationId: ORG_ID });
}
