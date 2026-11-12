import { derivePlanStatus, getCurrentApprovalResources, type PlanApprovalState, type PlanStatusRoute } from "./plan-status.ts";

/**
 * Pure presentation derivations for the planner workspace header.
 * Only reads fields already present on server payloads. Unknown evidence is
 * reported as "unknown" and must never render as complete.
 */

export type WorkspaceRoute = PlanStatusRoute & {
  id: string;
  dispatchSnapshotVersion?: number | null;
  planId?: string | null;
  name?: string | null;
  customerReference?: string | null;
};

export interface WorkspaceScopeInput {
  planId?: string | null;
  day?: string | null;
  routeId?: string | null;
  routes: readonly WorkspaceRoute[];
  scheduledStopCount: number | null;
  unassignedCount: number | null;
}

export type RevisionEvidence =
  | { kind: "unanimous"; value: number }
  | { kind: "mixed"; values: number[] }
  | { kind: "unknown" };

export interface HandoffEvidence {
  /** Routes whose handoff receipt is verified against the current revision. */
  current: number;
  /** Routes with a receipt for an older revision (compared per route). */
  stale: number;
  /** Routes with a receipt whose revision cannot be compared. */
  unverified: number;
  /** Routes without any non-pending receipt. Not proof of never sent. */
  none: number;
}

export interface WorkspaceScope {
  kind: "plan" | "route" | "global";
  title: string;
  dateLabel: string;
  dateDetail: string | null;
  routeCount: number;
  stopCount: number | null;
  unassignedCount: number | null;
  resourceCount: number;
  revision: RevisionEvidence;
  outgoingRevision: RevisionEvidence;
  handoff: HandoffEvidence;
}

export function deriveRevisionEvidence(routes: readonly PlanStatusRoute[]): RevisionEvidence {
  if (routes.length === 0) return { kind: "unknown" };
  const values = routes.map((r) => r.planRevision);
  if (values.some((v) => typeof v !== "number")) return { kind: "unknown" };
  const unique = Array.from(new Set(values as number[])).sort((a, b) => a - b);
  return unique.length === 1 ? { kind: "unanimous", value: unique[0] } : { kind: "mixed", values: unique };
}

/** Receipt is current only when both revisions are known and equal on the same route. */
export function isVerifiedCurrentHandoff(r: PlanStatusRoute): boolean {
  return Boolean(r.handoffStatus && r.handoffStatus !== "pending"
    && typeof r.handoffVersion === "number" && typeof r.planRevision === "number"
    && r.handoffVersion === r.planRevision);
}

export function deriveHandoffEvidence(routes: readonly PlanStatusRoute[]): HandoffEvidence {
  const e: HandoffEvidence = { current: 0, stale: 0, unverified: 0, none: 0 };
  for (const r of routes) {
    if (!r.handoffStatus || r.handoffStatus === "pending") e.none++;
    else if (typeof r.handoffVersion !== "number" || typeof r.planRevision !== "number") e.unverified++;
    else if (r.handoffVersion === r.planRevision) e.current++;
    else e.stale++;
  }
  return e;
}

export function formatDateRange(dates: readonly (string | null | undefined)[]): string | null {
  const unique = Array.from(new Set(dates.filter((d): d is string => Boolean(d)).map((d) => d.slice(0, 10)))).sort();
  if (unique.length === 0) return null;
  if (unique.length === 1) return unique[0];
  return `${unique[0]} – ${unique[unique.length - 1]}`;
}

export function deriveWorkspaceScope(input: WorkspaceScopeInput): WorkspaceScope {
  const { routes } = input;
  const kind: WorkspaceScope["kind"] = input.planId ? "plan" : input.routeId ? "route" : "global";
  const range = formatDateRange(routes.map((r) => r.date));
  const first = routes[0];
  const title = kind === "global"
    ? "Ingen plan vald"
    : kind === "plan"
      ? first?.customerReference || first?.name || `Plan ${String(input.planId).slice(0, 8)}`
      : first?.name || `Rutt ${String(input.routeId).slice(0, 8)}`;
  // Without a plan there is no board; never present a cross-project range.
  const dateLabel = kind === "global" ? "Välj plan och dag" : input.day || range || "Datum saknas";
  const dateDetail = null;
  const resources = new Set(routes.map((r) => r.vehicleId).filter(Boolean));
  return {
    kind, title, dateLabel, dateDetail,
    routeCount: routes.length,
    stopCount: input.scheduledStopCount == null || input.unassignedCount == null
      ? null
      : input.scheduledStopCount + input.unassignedCount,
    unassignedCount: input.unassignedCount,
    resourceCount: resources.size,
    revision: deriveRevisionEvidence(routes),
    outgoingRevision: deriveRevisionEvidence(routes.map(route => ({ planRevision: route.dispatchSnapshotVersion }))),
    handoff: deriveHandoffEvidence(routes),
  };
}

export type MomentId = "underlag" | "resurser" | "planforslag" | "granskning" | "godkann" | "utforande";
export type MomentState = "done" | "attention" | "active" | "pending" | "unknown";

export interface WorkflowMoment {
  id: MomentId;
  label: string;
  state: MomentState;
  evidence: string;
}

export interface WorkflowInput {
  scopeKind: WorkspaceScope["kind"];
  routes: readonly WorkspaceRoute[];
  scheduledStopCount: number | null;
  unassignedCount: number | null;
  approval?: PlanApprovalState | null;
  approvalLoading?: boolean;
  approvalError?: boolean;
}

const CALCULATED = new Set(["optimized", "in_progress", "completed"]);

export interface ReviewScopeNotice {
  routeCount: number;
  plans: { planId: string; label: string; routeCount: number; href: string }[];
  unlinkedRoutes: { id: string; label: string }[];
}

/** Explain stored flags without claiming they are stale or fetching approval for another scope. */
export function deriveReviewScopeNotice(scopeKind: WorkspaceScope["kind"], routes: readonly WorkspaceRoute[]): ReviewScopeNotice | null {
  if (scopeKind === "plan") return null;
  const flagged = routes.filter(route => route.manualReviewRequired && !route.manualReviewedAt);
  if (!flagged.length) return null;
  const plans = new Map<string, ReviewScopeNotice["plans"][number]>();
  const unlinkedRoutes: ReviewScopeNotice["unlinkedRoutes"] = [];
  for (const route of flagged) {
    if (!route.planId) {
      unlinkedRoutes.push({ id: route.id, label: route.name || `Rutt ${route.id}` });
      continue;
    }
    const existing = plans.get(route.planId);
    if (existing) existing.routeCount++;
    else plans.set(route.planId, {
      planId: route.planId,
      label: `${route.customerReference || route.name || "Plan"} · ${route.planId}`,
      routeCount: 1,
      // Start a clean scope: never carry a global day or another route filter.
      href: `/dispatch?${new URLSearchParams({ view: "traffic", planId: route.planId })}`,
    });
  }
  return { routeCount: flagged.length, plans: [...plans.values()], unlinkedRoutes };
}

/** Protected approval that maps exactly to every route's current revision and is approved. */
export function hasExactCurrentApproval(routes: readonly WorkspaceRoute[], approval?: PlanApprovalState | null): boolean {
  if (!approval?.protected || routes.length === 0) return false;
  const current = getCurrentApprovalResources(routes, approval);
  if (!current) return false;
  return routes.every((r) => {
    const a = approval.routes?.find((c) => c.routeId === r.id);
    return Boolean(a?.approval?.approved && a.planRevision === r.planRevision);
  });
}

export function deriveWorkflowMoments(input: WorkflowInput): WorkflowMoment[] {
  const { routes } = input;
  const n = routes.length;
  const unassignedUnknown = input.unassignedCount == null;
  const dataUnknown = input.scheduledStopCount == null || unassignedUnknown;
  const total = (input.scheduledStopCount ?? 0) + (input.unassignedCount ?? 0);
  const m = (id: MomentId, label: string, state: MomentState, evidence: string): WorkflowMoment => ({ id, label, state, evidence });

  // Presence of orders is not validation evidence.
  const underlag = dataUnknown
    ? m("underlag", "Underlag", "unknown", "Uppdragsdata kunde inte läsas")
    : total === 0
      ? m("underlag", "Underlag", "pending", "Inga uppdrag i vyn")
      : m("underlag", "Underlag", "active", `${total} uppdrag inlästa, validering ej verifierad här`);

  let resurser: WorkflowMoment;
  if (n === 0) resurser = m("resurser", "Resurser", "pending", "Inga rutter");
  else {
    const noVehicle = routes.filter((r) => !r.vehicleId).length;
    const driverUnknown = routes.filter((r) => r.driverId === undefined).length;
    const noDriver = routes.filter((r) => r.driverId === null || r.driverId === "").length;
    if (noVehicle + noDriver > 0) {
      resurser = m("resurser", "Resurser", "attention", `${noVehicle} utan fordon, ${noDriver} utan förare av ${n}`);
    } else if (driverUnknown > 0) {
      resurser = m("resurser", "Resurser", "unknown", `Förare okänd för ${driverUnknown} av ${n}`);
    } else {
      resurser = m("resurser", "Resurser", "done", `${n} rutter med fordon och förare`);
    }
  }

  const calculated = routes.filter((r) => r.status && CALCULATED.has(r.status)).length;
  const exactApproval = input.scopeKind === "plan" && !input.approvalLoading && !input.approvalError
    && hasExactCurrentApproval(routes, input.approval);
  // A current protected approval is stronger evidence than the legacy review
  // flag. A changed revision or unavailable approval still exposes that flag.
  const reviewFlag = exactApproval ? 0 : routes.filter((r) => r.manualReviewRequired && !r.manualReviewedAt).length;
  let planforslag: WorkflowMoment;
  if (n === 0) planforslag = m("planforslag", "Planförslag", "pending", "Ingen rutt beräknad");
  else if (unassignedUnknown) planforslag = m("planforslag", "Planförslag", "unknown", `Beräknade ${calculated}/${n}, ej tilldelade okänt`);
  else if ((input.unassignedCount ?? 0) > 0 || reviewFlag > 0) {
    planforslag = m("planforslag", "Planförslag", "attention",
      `Beräknade ${calculated}/${n}, ${input.unassignedCount} ej tilldelade${reviewFlag ? `, ${reviewFlag} rutter väntar på granskning` : ""}`);
  } else planforslag = exactApproval
    ? m("planforslag", "Planförslag", "done", `Beräknade ${calculated}/${n}, aktuell version godkänd`)
    : m("planforslag", "Planförslag", calculated > 0 ? "active" : "pending", `Beräknade ${calculated}/${n} (ej genomförbarhetsprövat)`);

  let granskning: WorkflowMoment;
  if (n === 0) granskning = m("granskning", "Granskning", "pending", "Inget att granska");
  else if (reviewFlag > 0) granskning = m("granskning", "Granskning", "attention",
    input.scopeKind === "plan" ? `${reviewFlag} rutter kräver manuell granskning` : `${reviewFlag} rutter med sparad granskningsflagga; godkännande ej verifierat här`);
  else if (exactApproval) granskning = m("granskning", "Granskning", "done", "Godkänd för aktuell version");
  else if (calculated < n) granskning = m("granskning", "Granskning", "pending", "Väntar på beräkning");
  else granskning = m("granskning", "Granskning", "active", "Ingen manuell flagga, granskning ej verifierad");

  let godkann: WorkflowMoment;
  const G = "Godkänn och skicka";
  if (n === 0) godkann = m("godkann", G, "pending", "Inga rutter");
  else {
    const h = deriveHandoffEvidence(routes);
    const rejected = routes.filter((r) => r.handoffStatus === "rejected" && isVerifiedCurrentHandoff(r)).length;
    const plan = derivePlanStatus({ routes, approval: input.scopeKind === "plan" && !input.approvalLoading && !input.approvalError ? input.approval : null, approvalAvailability: "checking" });
    if (rejected > 0) godkann = m("godkann", G, "attention", `${rejected} avvisade av förare`);
    else if (h.stale > 0) godkann = m("godkann", G, "attention", `${h.stale} rutter ändrade efter utskick`);
    else if (unassignedUnknown) godkann = m("godkann", G, "unknown", "Ej tilldelade okänt");
    else if (h.current === n && (input.unassignedCount ?? 0) === 0) godkann = m("godkann", G, "done", `Aktuell kvittens ${h.current}/${n}`);
    else if (h.current > 0) godkann = m("godkann", G, "active", `Aktuell kvittens ${h.current}/${n}`);
    else if (h.unverified > 0) godkann = m("godkann", G, "unknown", `${h.unverified} kvittenser utan versionsbevis`);
    else if (input.scopeKind !== "plan") godkann = m("godkann", G, "unknown", "Godkännande kan bara läsas i planvy");
    else if (input.approvalLoading) godkann = m("godkann", G, "unknown", "Hämtar godkännande…");
    else if (input.approvalError) godkann = m("godkann", G, "unknown", "Godkännande kunde inte läsas");
    else godkann = m("godkann", G, exactApproval ? "active" : "pending",
      exactApproval ? "Godkänd, ingen aktuell utskickskvittens" : `Godkända ${plan.approvedCount}/${n} för aktuell version`);
  }

  const running = routes.filter((r) => r.status === "in_progress").length;
  const completed = routes.filter((r) => r.status === "completed").length;
  const utforande = n > 0 && completed === n
    ? m("utforande", "Utförande", "done", `${completed} rutter avslutade`)
    : running > 0
      ? m("utforande", "Utförande", "active", `${running} pågår, ${completed} avslutade`)
      : m("utforande", "Utförande", "pending", "Ingen rutt har startat");

  return [underlag, resurser, planforslag, granskning, godkann, utforande];
}
