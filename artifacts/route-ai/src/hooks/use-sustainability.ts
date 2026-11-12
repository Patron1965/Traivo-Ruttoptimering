import { useGetSustainabilityStats as useGeneratedGetSustainabilityStats } from "@workspace/api-client-react";
import { useAuth } from "@/lib/auth-context";

export function useSustainabilityStats() {
  const { user } = useAuth();
  const organizationId = user?.organizationId;
  return useGeneratedGetSustainabilityStats({ organizationId: organizationId! }, {
    query: { queryKey: ["/api/sustainability/stats", organizationId], enabled: !!organizationId },
  });
}
