import { useGetSustainabilityStats as useGeneratedGetSustainabilityStats } from "@workspace/api-client-react";
import { ORG_ID } from "@/lib/constants";

export function useSustainabilityStats() {
  return useGeneratedGetSustainabilityStats({ organizationId: ORG_ID });
}
