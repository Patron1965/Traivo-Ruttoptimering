/**
 * Pure helpers for "Lägg till från stoppregistret". The register is a
 * recurring-stop library: a customer group (e.g. "Måndagsturen") holds
 * reusable visit sites. Kept free of React so it can be tested with node.
 */

export type RegisterSite = {
  id: string;
  name: string;
  address: string;
  archivedAt?: string | null;
  isPrioritized?: boolean;
};

export type RegisterGroup = {
  id: string;
  name: string;
  archivedAt?: string | null;
  sites: RegisterSite[];
};

export type StopRegisterTarget =
  | {
      kind: "draft";
      draftId: string;
      name: string;
      date: string;
    }
  | {
      kind: "plan";
      planId: string;
      name: string;
      date: string;
      routes: Array<{ routeId: string; planRevision: number }>;
    };

export function activeRegisterSites(group: RegisterGroup): RegisterSite[] {
  if (group.archivedAt) return [];
  return group.sites.filter((site) => !site.archivedAt);
}

/** Groups whose name, or any active site name/address, matches the query. */
export function filterRegister(groups: RegisterGroup[], query: string): Array<{ group: RegisterGroup; sites: RegisterSite[] }> {
  const q = query.trim().toLocaleLowerCase("sv-SE");
  const result: Array<{ group: RegisterGroup; sites: RegisterSite[] }> = [];
  for (const group of groups) {
    const sites = activeRegisterSites(group);
    if (sites.length === 0) continue;
    if (!q || group.name.toLocaleLowerCase("sv-SE").includes(q)) {
      result.push({ group, sites });
      continue;
    }
    const matching = sites.filter((site) =>
      site.name.toLocaleLowerCase("sv-SE").includes(q)
      || site.address.toLocaleLowerCase("sv-SE").includes(q));
    if (matching.length > 0) result.push({ group, sites: matching });
  }
  return result;
}

export function groupCheckState(sites: RegisterSite[], selected: ReadonlySet<string>): boolean | "indeterminate" {
  const count = sites.filter((site) => selected.has(site.id)).length;
  if (count === 0) return false;
  return count === sites.length ? true : "indeterminate";
}

export function toggleSites(selected: ReadonlySet<string>, siteIds: string[], checked: boolean): Set<string> {
  const next = new Set(selected);
  for (const id of siteIds) {
    if (checked) next.add(id);
    else next.delete(id);
  }
  return next;
}

/** Drop selections that are no longer active in the register. */
export function reconcileRegisterSelection(groups: RegisterGroup[], selected: ReadonlySet<string>): Set<string> {
  const active = new Set(groups.flatMap((group) => activeRegisterSites(group).map((site) => site.id)));
  return new Set([...selected].filter((id) => active.has(id)));
}

/** Stable request fingerprint: retries reuse the key, any payload change rotates it. */
export function stopRegisterFingerprint(target: StopRegisterTarget, siteIds: string[], allowDuplicateVisits: boolean): string {
  const targetId = target.kind === "draft" ? `d:${target.draftId}` : `p:${target.planId}`;
  return [targetId, target.date, allowDuplicateVisits ? "dup" : "nodup", [...siteIds].sort().join(",")].join("|");
}

export type StopRegisterRequest = {
  siteIds: string[];
  date: string;
  idempotencyKey: string;
  draftId?: string;
  draftRevision?: number;
  planId?: string;
  routes?: Array<{ routeId: string; planRevision: number }>;
  allowDuplicateVisits?: boolean;
};

export function buildStopRegisterRequest(input: {
  target: StopRegisterTarget;
  siteIds: string[];
  idempotencyKey: string;
  draftRevision?: number;
  allowDuplicateVisits: boolean;
}): StopRegisterRequest {
  const base: StopRegisterRequest = {
    siteIds: [...input.siteIds].sort(),
    date: input.target.date,
    idempotencyKey: input.idempotencyKey,
  };
  if (input.allowDuplicateVisits) base.allowDuplicateVisits = true;
  if (input.target.kind === "draft") {
    if (input.draftRevision == null) throw new Error("STOP_REGISTER_DRAFT_REVISION_MISSING");
    return { ...base, draftId: input.target.draftId, draftRevision: input.draftRevision };
  }
  if (input.target.routes.length === 0) throw new Error("STOP_REGISTER_PLAN_ROUTES_MISSING");
  return {
    ...base,
    planId: input.target.planId,
    routes: input.target.routes.map((route) => ({ routeId: route.routeId, planRevision: route.planRevision })),
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

/** Returns duplicate site ids for DUPLICATE_CUSTOMER_VISITS, otherwise null. */
export function duplicateVisitSiteIds(error: unknown): string[] | null {
  const root = record(error);
  const candidates = [root, record(root?.data), record(root?.body), record(record(root?.response)?.data)];
  for (const candidate of candidates) {
    if (!candidate || candidate.code !== "DUPLICATE_CUSTOMER_VISITS") continue;
    const details = record(candidate.details);
    const ids = Array.isArray(details?.siteIds) ? details!.siteIds : [];
    return ids.filter((id): id is string => typeof id === "string");
  }
  return null;
}

export function errorStatusOf(error: unknown): number | undefined {
  const root = record(error);
  const status = root?.status ?? record(root?.response)?.status;
  return typeof status === "number" ? status : undefined;
}

/** Stale target / revision conflicts must be re-reviewed, never replayed. */
export function isStaleTargetError(error: unknown): boolean {
  if (duplicateVisitSiteIds(error) !== null) return false;
  const status = errorStatusOf(error);
  return status === 409 || status === 412 || status === 410;
}

/** Identity of a target including revisions; any change requires re-review. */
export function stopRegisterTargetIdentity(target: StopRegisterTarget | null): string {
  if (!target) return "";
  if (target.kind === "draft") return `d:${target.draftId}|${target.date}|${target.name}`;
  const routes = [...target.routes]
    .sort((a, b) => a.routeId.localeCompare(b.routeId))
    .map((route) => `${route.routeId}@${route.planRevision}`)
    .join(",");
  return `p:${target.planId}|${target.date}|${target.name}|${routes}`;
}

/** Scope without revisions: same target object and day. */
export function stopRegisterScopeKey(target: StopRegisterTarget | null): string {
  if (!target) return "";
  return target.kind === "draft" ? `d:${target.draftId}|${target.date}` : `p:${target.planId}|${target.date}`;
}

export type StopRegisterCommitted = {
  stopIds: string[];
  count: number;
  draftId?: string;
  planId?: string;
};

export type SubmissionOutcome =
  | { kind: "success"; result: StopRegisterCommitted }
  | { kind: "hydration_failed"; result: StopRegisterCommitted; error: unknown }
  | { kind: "duplicate"; siteIds: string[] }
  | { kind: "stale"; error: unknown }
  | { kind: "retryable"; error: unknown }
  | { kind: "scope_mismatch" }
  | { kind: "busy" };

/**
 * Serializes one logical submission:
 * - an ambiguous failure (network/5xx) keeps the exact request (same key,
 *   same draftRevision/route revisions) and a retry resends it byte-for-byte;
 * - once the server commits, the result is retained and only hydration may be
 *   retried; a second mutation is never sent;
 * - stale/conflict and duplicate responses discard the attempt, nothing replays.
 */
export function createStopRegisterSubmission(deps: {
  mutate: (request: StopRegisterRequest) => Promise<StopRegisterCommitted>;
  prepare?: () => Promise<{ draftRevision?: number }>;
  hydrate: (result: StopRegisterCommitted) => Promise<void> | void;
  newKey: () => string;
}) {
  let attempt: { fingerprint: string; scope: string; request: StopRegisterRequest } | null = null;
  let committed: StopRegisterCommitted | null = null;
  let busy = false;

  const runHydration = async (result: StopRegisterCommitted): Promise<SubmissionOutcome> => {
    try {
      await deps.hydrate(result);
      return { kind: "success", result };
    } catch (error) {
      return { kind: "hydration_failed", result, error };
    }
  };

  return {
    get committed() { return committed; },
    get pendingRequest() { return attempt?.request ?? null; },
    /** True after an ambiguous failure: the server may or may not have committed. */
    get unresolved() { return attempt !== null && committed === null; },
    async submit(target: StopRegisterTarget, siteIds: string[], allowDuplicateVisits: boolean): Promise<SubmissionOutcome> {
      if (busy) return { kind: "busy" };
      busy = true;
      try {
        if (committed) return await runHydration(committed);
        if (attempt) {
          // An unresolved attempt is always replayed byte-for-byte, even if
          // polling has since bumped revisions (possibly by our own commit).
          // Only a different target object or day is refused.
          if (attempt.scope !== stopRegisterScopeKey(target)) return { kind: "scope_mismatch" };
        } else {
          const fingerprint = `${stopRegisterTargetIdentity(target)}#${stopRegisterFingerprint(target, siteIds, allowDuplicateVisits)}`;
          const prepared = deps.prepare ? await deps.prepare() : {};
          attempt = {
            fingerprint,
            scope: stopRegisterScopeKey(target),
            request: buildStopRegisterRequest({
              target,
              siteIds,
              allowDuplicateVisits,
              draftRevision: prepared.draftRevision,
              idempotencyKey: deps.newKey(),
            }),
          };
        }
        let result: StopRegisterCommitted;
        try {
          result = await deps.mutate(attempt.request);
        } catch (error) {
          const duplicates = duplicateVisitSiteIds(error);
          if (duplicates !== null) {
            attempt = null;
            return { kind: "duplicate", siteIds: duplicates.length > 0 ? duplicates : [...siteIds] };
          }
          if (isStaleTargetError(error)) {
            attempt = null;
            return { kind: "stale", error };
          }
          return { kind: "retryable", error };
        }
        committed = result;
        attempt = null;
        return await runHydration(result);
      } finally {
        busy = false;
      }
    },
    async retryHydration(): Promise<SubmissionOutcome | null> {
      if (!committed || busy) return null;
      busy = true;
      try {
        return await runHydration(committed);
      } finally {
        busy = false;
      }
    },
  };
}
