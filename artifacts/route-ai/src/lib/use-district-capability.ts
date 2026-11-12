import { useGetOrganizationCapabilities } from "@workspace/api-client-react";
import { useAuth } from "./auth-context";
import { districtCapabilityAllowed, districtCapabilityKey } from "./district-capability";

/** Identity-partitioned, no previous-tenant data, and no cached grant before revalidation. */
export function useDistrictCapability() {
  const { user, isLoggingOut } = useAuth();
  const query = useGetOrganizationCapabilities({
    query: {
      queryKey: districtCapabilityKey(user),
      enabled: !!user && !isLoggingOut,
      staleTime: 0,
      gcTime: 0,
      retry: false,
      refetchOnMount: "always",
      refetchOnWindowFocus: "always",
      refetchInterval: 30_000,
    },
  });
  return {
    allowed: districtCapabilityAllowed(!!user && !isLoggingOut, query),
    loading: query.isLoading,
    error: query.isError,
  };
}
