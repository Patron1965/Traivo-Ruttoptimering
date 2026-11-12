import { useGetDashboardStats as useGeneratedGetDashboardStats } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";

export function useDashboardStats() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useGeneratedGetDashboardStats({ organizationId: organizationId! }, {
    query: { queryKey: ["/api/dashboard/stats", organizationId], enabled: !!organizationId },
  });
}
