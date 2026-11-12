export type ImportDraftStateProjectionOptions = {
  /**
   * A server-owned importedResult contains the persisted stop records. Keep
   * legacy savedStops only when that evidence is not available yet (or for a
   * manual draft that has no import result).
   */
  hasAuthoritativeImportedResult: boolean;
  /**
   * Once a plan exists, assignedRoutes is only a client projection. Approval
   * and route reads are authoritative and avoid serializing route DTOs,
   * geometry, or workday timelines into the bounded draft state.
   */
  serverPlanId?: string | null;
};

/**
 * Project the wizard state into the bounded payload sent by draft PUTs.
 *
 * Raw source rows, candidate coordinates, mapped values, selections,
 * diagnostics, and stop IDs remain intact. Only redundant server-derived
 * snapshots are removed when their authoritative server source is known.
 */
export function projectImportDraftState(
  state: Record<string, any>,
  options: ImportDraftStateProjectionOptions,
): Record<string, any> {
  const projected = { ...state };
  if (options.hasAuthoritativeImportedResult) {
    delete projected.savedStops;
  }
  if (options.serverPlanId) {
    delete projected.assignedRoutes;
  }
  return projected;
}

/** Supplemental membership augments, never replaces, original import evidence. */
export function supplementalDraftStopIds(state: Record<string, any> | null | undefined): string[] {
  return [...new Set([
    ...(Array.isArray(state?.customerVisitStopIds) ? state.customerVisitStopIds : []),
    ...(Array.isArray(state?.appendedStopIds) ? state.appendedStopIds : []),
    ...(Array.isArray(state?.dispatchSourceStopIds) ? state.dispatchSourceStopIds : []),
  ].filter((id): id is string => typeof id === "string" && id.length > 0))];
}