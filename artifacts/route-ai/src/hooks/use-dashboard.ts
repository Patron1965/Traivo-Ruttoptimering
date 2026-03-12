import { useGetDashboardStats as useGeneratedGetDashboardStats } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

export function useDashboardStats() {
  return useGeneratedGetDashboardStats({ organizationId: ORG_ID });
}
