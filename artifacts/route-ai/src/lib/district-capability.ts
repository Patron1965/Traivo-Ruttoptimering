export function districtCapabilityKey(user: { id: string; organizationId: string } | null) {
  return ["/organization/capabilities", user?.id, user?.organizationId] as const;
}

export function districtCapabilityAllowed(
  authenticated: boolean,
  query: { isFetchedAfterMount: boolean; isError: boolean; data?: { districtEnabled: boolean } },
) {
  return authenticated && query.isFetchedAfterMount && !query.isError && query.data?.districtEnabled === true;
}
