import { Check, ChevronDown, Circle, CircleAlert, Loader2 } from "lucide-react";
import { useImportInfo } from "@/components/import/ImportInfoDisclosure";
import { isStatusChainPartVisible } from "@/lib/import-info-disclosure";
import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import {
  derivePlanStatus,
  deriveNoServerPlanStatus,
  getCurrentApprovalResources,
  type PlanApprovalAvailability,
  type PlanApprovalState,
  type PlanBlocker,
  type PlanStatusResult,
  type PlanStatusRoute,
} from "@/lib/plan-status";

const STEPS = [
  "planner.statusImported",
  "planner.statusValidated",
  "planner.statusProposal",
  "planner.statusAdjusted",
  "planner.statusReady",
  "planner.statusSent",
] as const;

const STATUS_KEYS: Record<string, string> = {
  draft: "planner.statusDraft",
  calculated: "planner.statusCalculated",
  needs_review: "planner.statusNeedsReview",
  approval_checking: "planner.statusApprovalChecking",
  ready_for_approval: "planner.statusReadyForApproval",
  dispatch_ready: "planner.statusDispatchReady",
  partially_approved: "planner.statusPartiallyApproved",
  approved: "planner.statusApproved",
  partially_sent: "planner.statusPartiallySent",
  sent: "planner.statusSent",
  partially_received: "planner.statusPartiallyReceived",
  received: "planner.statusReceived",
  partially_accepted: "planner.statusPartiallyAccepted",
  accepted: "planner.statusAccepted",
  rejected: "planner.statusRejected",
};

const ACTION_KEYS: Record<string, string> = {
  build: "planner.nextBuild",
  review: "planner.nextReview",
  approve: "planner.nextApprove",
  send: "planner.nextSend",
  follow_up: "planner.nextFollowUp",
  resolve_rejection: "planner.nextResolveRejection",
  live: "planner.nextLive",
};

const BLOCKER_KEYS: Record<string, string> = {
  unplannedStops: "planner.blockerUnplannedStops",
  missingVehicle: "planner.blockerMissingVehicle",
  missingDriver: "planner.blockerMissingDriver",
  manualReview: "planner.blockerManualReview",
};

function copy(
  t: (key: string, options?: Record<string, unknown>) => string,
  key: string,
  fallback: string,
  options: Record<string, unknown> = {},
) {
  return t(key, { defaultValue: fallback, ...options });
}

type ResourceNames = {
  vehicles?: Record<string, string>;
  drivers?: Record<string, string>;
};

export function PlanStatusChain({
  stage,
  planId,
  revision,
  className,
  compact = false,
  routes,
  approval,
  unplannedCount,
  planName,
  date,
  orderCount,
  resourceCount,
  onNextAction,
  stateLoading = false,
  stateError,
  onRetry,
  actionPending = false,
  onBlockerAction,
  resourceNames,
  importVariant = false,
}: {
  /** Kept for callers that show a local draft before a server route exists. */
  stage?: number;
  planId?: string | null;
  revision?: number | null;
  className?: string;
  compact?: boolean;
  routes?: readonly PlanStatusRoute[];
  approval?: PlanApprovalState | null;
  unplannedCount?: number;
  planName?: string | null;
  date?: string | null;
  orderCount?: number | null;
  resourceCount?: number | null;
  onNextAction?: () => void;
  stateLoading?: boolean;
  stateError?: string | null;
  onRetry?: () => void;
  actionPending?: boolean;
  onBlockerAction?: (blocker: PlanBlocker) => void;
  resourceNames?: ResourceNames;
  /** Compact import-only variant: details collapse behind "Planöversikt". */
  importVariant?: boolean;
}) {
  const { t } = useTranslation();
  const importInfo = useImportInfo();
  const detailsOpen = !importVariant || !importInfo.inImportFlow || importInfo.visible.overview;
  const show = (part: Parameters<typeof isStatusChainPartVisible>[0]) => isStatusChainPartVisible(part, detailsOpen);
  const approvalAvailability: PlanApprovalAvailability = stateLoading || stateError
    ? "checking"
    : approval?.protected
      ? "protected"
      : "not_protected";
  const status: PlanStatusResult = !planId
    ? deriveNoServerPlanStatus(unplannedCount)
    : routes && routes.length > 0
    ? derivePlanStatus({ routes, approval, approvalAvailability, unplannedCount })
    : {
         stage: stateLoading || stateError ? 3 : stage ?? 0,
        routeCount: routes?.length ?? 0,
        approvedCount: 0,
        sentCount: 0,
        receivedCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        status: stateLoading || stateError
          ? "approval_checking"
          : stage == null || stage <= 0
          ? "draft"
          : stage >= 5
            ? "sent"
            : stage >= 4
              ? "ready_for_approval"
              : stage >= 3
                ? "needs_review"
                : "calculated",
        nextAction: stateLoading || stateError
          ? "review"
          : stage != null && stage >= 5
          ? "follow_up"
          : stage != null && stage >= 4
            ? "approve"
            : "review",
        blockers: [],
      };
  const resolvedStage = Math.max(0, Math.min(STEPS.length - 1, status.stage));
  const displayPlanName = planName || (planId ? `Plan ${planId.slice(0, 8)}` : copy(t, "planner.newPlan", "Ny plan"));
  const resolvedDate = date || routes?.find((route) => route.date)?.date;
  const resolvedOrders = orderCount ?? routes?.reduce((sum, route) => sum + (route.totalStops ?? 0), 0);
  const currentApprovalResources = routes
    ? getCurrentApprovalResources(routes, approval)
    : null;
  const resourceSource = currentApprovalResources
    ?? (approval?.protected
      ? (routes ?? []).map(() => ({
          vehicleId: null,
          driverId: null,
          vehicleName: null,
          driverName: null,
        }))
      : routes ?? []);
  const resourcePairs = resourceSource.map((resource, index) => {
    const vehicleId = resource.vehicleId ?? null;
    const driverId = resource.driverId ?? (
      "handoffDriverId" in resource ? resource.handoffDriverId ?? null : null
    );
    return {
      key: `${vehicleId ?? "unknown"}:${driverId ?? "unknown"}`,
      vehicleId,
      driverId,
      vehicleName: resource.vehicleName ?? (
        vehicleId ? resourceNames?.vehicles?.[vehicleId] : undefined
      ),
      driverName: resource.driverName ?? (
        driverId ? resourceNames?.drivers?.[driverId] : undefined
      ),
      index,
    };
  }).filter((resource, index, all) =>
    all.findIndex((candidate) => candidate.key === resource.key) === index,
  );
  const resolvedResources = resourcePairs.length > 0
    ? resourcePairs.map((resource) => {
        const vehicle = resource.vehicleName
          ?? (resource.vehicleId ? copy(t, "planner.unknownVehicle", "Okänt fordon") : copy(t, "planner.unknownVehicle", "Okänt fordon"));
        const driver = resource.driverName
          ?? (resource.driverId ? copy(t, "planner.unknownDriver", "Okänd förare") : copy(t, "planner.unknownDriver", "Okänd förare"));
        return `${vehicle} / ${driver}`;
      }).join(", ")
    : copy(t, "planner.unknownResources", "Resurser okända");
  const statusLabel = copy(
    t,
    STATUS_KEYS[status.status] ?? "planner.statusCalculated",
    status.status.replaceAll("_", " "),
  );
  const nextActionLabel = copy(
    t,
    ACTION_KEYS[status.nextAction] ?? "planner.nextReview",
    status.nextAction.replaceAll("_", " "),
  );
  const countLabel = (count: number) => `${count}/${status.routeCount}`;

  return (
    <section
      className={cn("rounded-xl border border-border bg-card/80", compact ? "p-2" : "p-3", className)}
      data-testid="plan-status-chain"
      data-plan-status={status.status}
    >
      <div className={cn("flex flex-wrap items-start justify-between gap-x-3 gap-y-2", compact ? "mb-2" : "mb-3")}>
        <div className={cn("min-w-0", compact && "flex flex-wrap items-baseline gap-x-2")}>
          {!compact && (
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              {copy(t, "planner.statusFlow", "Planflöde")}
            </p>
          )}
          <p className="truncate text-sm font-bold" data-testid="plan-context-name">{displayPlanName}</p>
          {show("context") && <div
            className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted-foreground"
            data-testid="plan-context"
          >
            {resolvedDate && <span>{copy(t, "planner.contextDate", "Datum")}: {resolvedDate}</span>}
            {resolvedOrders != null && (
              <span>{copy(t, "planner.contextOrders", "Order", { count: resolvedOrders })}: {resolvedOrders}</span>
            )}
            {resolvedResources != null && (
              <span>{copy(t, "planner.contextResources", "Resurser")}: {resolvedResources}</span>
            )}
          </div>}
          {show("lifecycle") && <div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px] text-muted-foreground" data-testid="plan-lifecycle-counts">
            <span>{copy(t, "planner.approvalCount", "Godkända")}: {countLabel(status.approvedCount)}</span>
            <span>{copy(t, "planner.sentCount", "Skickade")}: {countLabel(status.sentCount)}</span>
            <span>{copy(t, "planner.receivedCount", "Mottagna")}: {countLabel(status.receivedCount)}</span>
            <span>{copy(t, "planner.acceptedCount", "Accepterade")}: {countLabel(status.acceptedCount)}</span>
          </div>}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            className="rounded-full bg-primary/10 px-2.5 py-1 text-xs font-semibold leading-tight text-primary"
            data-testid="plan-current-status"
          >
            {statusLabel}
          </span>
          {importVariant && importInfo.inImportFlow && (
            <button
              type="button"
              aria-expanded={detailsOpen}
              onClick={() => importInfo.set("overview")}
              className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-xs font-medium text-muted-foreground hover:bg-muted hover:text-foreground"
              data-testid="plan-status-details-toggle"
            >
              <ChevronDown className={cn("h-3.5 w-3.5 transition-transform", !detailsOpen && "-rotate-90")} />
              {detailsOpen ? "Dölj planöversikt" : "Visa planöversikt"}
            </button>
          )}
          {show("revision") && revision != null && (
            <span className="max-w-full rounded-full bg-muted px-2.5 py-1 text-xs font-semibold leading-tight text-muted-foreground">
              {copy(t, "planner.driverVersion", "Förarversion {{version}}", { version: revision + 1 })}
            </span>
          )}
        </div>
      </div>
      {stateLoading && (
        <p className="mb-2 text-xs text-muted-foreground" role="status" data-testid="plan-status-loading">
          {copy(t, "planner.statusLoading", "Hämtar aktuell planstatus…")}
        </p>
      )}
      {stateError && (
        <div className="mb-2 flex flex-wrap items-center gap-2 text-xs font-semibold text-destructive" role="alert" data-testid="plan-status-error">
          <span>{stateError}</span>
          {onRetry && (
            <button
              type="button"
              className="inline-flex items-center gap-1 underline disabled:cursor-not-allowed disabled:opacity-60"
              onClick={onRetry}
              disabled={actionPending}
            >
              {actionPending && <Loader2 className="h-3 w-3 animate-spin" />}
              {copy(t, "planner.retryStatus", "Försök igen")}
            </button>
          )}
        </div>
      )}
      <div
        className="mb-2 flex flex-wrap items-center justify-between gap-2 rounded-md border border-primary/20 bg-primary/5 px-2.5 py-1.5 text-xs"
        data-testid="plan-next-action"
      >
        <span>
          <strong>{copy(t, "planner.nextAction", "Nästa åtgärd")}:</strong>{" "}
          {nextActionLabel}
        </span>
        {(onNextAction || (onBlockerAction && status.blockers.length > 0)) && (
          <button
            type="button"
            className="inline-flex items-center gap-1 font-semibold text-primary hover:underline disabled:cursor-not-allowed disabled:opacity-60"
            disabled={actionPending}
            onClick={() => {
              const blocker = status.blockers.find((item) =>
                item.type === "unplannedStops"
                || item.type === "missingVehicle"
                || item.type === "missingDriver");
              if (blocker && onBlockerAction) {
                onBlockerAction(blocker);
                return;
              }
              onNextAction?.();
            }}
          >
            {actionPending && <Loader2 className="h-3 w-3 animate-spin" />}
            {copy(t, "planner.openNextAction", "Öppna")}
          </button>
        )}
      </div>
      {status.blockers.length > 0 && (
        <div className="mb-2 flex items-start gap-1.5 text-xs text-amber-700 dark:text-amber-300" data-testid="plan-blockers">
          <CircleAlert className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {copy(t, "planner.blockers", "Blockerare")}:{" "}
            {status.blockers.map((blocker) => copy(
              t,
              BLOCKER_KEYS[blocker.type] ?? "planner.blockerManualReview",
              blocker.type === "unplannedStops"
                ? "Unplanerade stopp: {{count}}"
                : blocker.type === "missingVehicle"
                  ? "Fordon saknas"
                  : blocker.type === "missingDriver"
                    ? "Förare saknas"
                    : "Manuell granskning krävs",
              blocker.count == null ? {} : { count: blocker.count },
            )).join(", ")}
          </span>
        </div>
      )}
      {show("steps") && <ol
        className={cn("grid", compact ? "gap-1.5" : "gap-2")}
        style={{
          gridTemplateColumns: `repeat(auto-fit, minmax(${compact ? "104px" : "116px"}, 1fr))`,
        }}
      >
        {STEPS.map((key, index) => {
          const complete = index < resolvedStage;
          const active = index === resolvedStage;
          return (
            <li
              key={key}
              className={cn(
                "flex min-h-10 min-w-0 items-center rounded-lg border px-2 text-xs leading-tight",
                compact ? "gap-1.5 py-1.5" : "gap-2 py-2",
                complete && "border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-400",
                active && "border-primary/50 bg-primary/10 font-semibold text-primary",
                index > resolvedStage && "border-border/60 text-muted-foreground",
              )}
            >
              {complete ? <Check className="h-3.5 w-3.5 shrink-0" /> : <Circle className="h-3.5 w-3.5 shrink-0" />}
              <span className="min-w-0">{copy(t, key, key.split(".").pop() ?? key)}</span>
            </li>
          );
        })}
      </ol>}
    </section>
  );
}
