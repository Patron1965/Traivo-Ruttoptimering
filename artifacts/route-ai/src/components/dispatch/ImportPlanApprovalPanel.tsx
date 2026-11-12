import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  approveImportRoutePlan,
  getGetImportRoutePlanApprovalQueryKey,
  getImportRoutePlanApproval,
  useGetImportRoutePlanApproval,
  type Route,
} from "@workspace/api-client-react";
import { useTranslation } from "react-i18next";
import {
  AlertTriangle,
  CheckCircle2,
  ClipboardCheck,
  Loader2,
  LockKeyhole,
  Send,
} from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Step7Dispatch } from "@/components/import/Step7Dispatch";
import { hasExactApprovedRouteSet } from "@/components/import/types";
import { localizeError } from "@/lib/localize-error";
import {
  getImportApprovalActionState,
  mapImportApprovalRoutes,
  type ImportApprovalMapping,
} from "./import-plan-approval";

interface ImportPlanApprovalPanelProps {
  requestedPlanId: string | null;
  liveRoutes: readonly Route[];
  showValidationSuccess?: boolean;
  canWrite: boolean;
  /** Continue to the live board after the explicit dispatch step completes. */
  onContinueLive: () => void;
}

function copy(t: (key: string, options?: Record<string, unknown>) => string, key: string, fallback: string, options: Record<string, unknown> = {}) {
  return t(key, { defaultValue: fallback, ...options });
}

export function ImportPlanApprovalPanel({
  requestedPlanId,
  liveRoutes,
  showValidationSuccess = false,
  canWrite,
  onContinueLive,
}: ImportPlanApprovalPanelProps) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const planId = requestedPlanId ?? "";
  const approvalQuery = useGetImportRoutePlanApproval(planId, {
    query: {
      queryKey: getGetImportRoutePlanApprovalQueryKey(planId),
      enabled: Boolean(requestedPlanId) && canWrite,
      staleTime: 0,
      refetchInterval: 10000,
      refetchOnWindowFocus: true,
    },
  });
  const [isApproving, setIsApproving] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const lastRouteSignature = useRef<string>("");

  const routeSignature = useMemo(
    () => liveRoutes
      .filter((route) => route.planId === planId)
      .map((route) => `${route.id}:${route.status}:${route.planRevision}:${route.vehicleId ?? ""}`)
      .sort()
      .join("|"),
    [liveRoutes, planId],
  );

  useEffect(() => {
    if (
      !requestedPlanId
      || !canWrite
      || !approvalQuery.data
      || !lastRouteSignature.current
      || lastRouteSignature.current === routeSignature
    ) {
      lastRouteSignature.current = routeSignature;
      return;
    }
    lastRouteSignature.current = routeSignature;
    void approvalQuery.refetch();
  }, [approvalQuery, canWrite, requestedPlanId, routeSignature]);

  const mapping = useMemo<ImportApprovalMapping>(() => mapImportApprovalRoutes(
    planId,
    [...liveRoutes],
    approvalQuery.data,
    hasExactApprovedRouteSet,
  ), [approvalQuery.data, liveRoutes, planId]);

  const routeNames = mapping.allPlanRoutes;
  const handleApprove = useCallback(async () => {
    if (!requestedPlanId || !canWrite || isApproving || !mapping.canApprove) return;
    setActionError(null);
    setIsApproving(true);
    try {
      // Re-read the protected plan immediately before the mutation. The
      // approval endpoint also revalidates under lock, but this keeps the
      // action from submitting a visibly stale recipient/revision tuple.
      const currentApproval = await getImportRoutePlanApproval(requestedPlanId);
      const currentMapping = mapImportApprovalRoutes(
        requestedPlanId,
        [...liveRoutes],
        currentApproval,
        hasExactApprovedRouteSet,
      );
      if (currentMapping.exact) {
        queryClient.setQueryData(approvalQuery.queryKey, currentApproval);
        return;
      }
      if (!currentMapping.canApprove) {
        throw new Error(copy(
          t,
          "dispatch.importApprovalStale",
          "Planen ändrades innan den kunde godkännas. Ladda om och granska planen igen.",
        ));
      }
      const approved = await approveImportRoutePlan(requestedPlanId, {
        routes: currentMapping.expectedRoutes,
      });
      const approvedMapping = mapImportApprovalRoutes(
        requestedPlanId,
        [...liveRoutes],
        approved,
        hasExactApprovedRouteSet,
      );
      if (!approvedMapping.exact) {
        throw new Error(copy(
          t,
          "dispatch.importApprovalIncomplete",
          "Servern bekräftade inte exakt samma rutter, versioner och förare.",
        ));
      }
      queryClient.setQueryData(approvalQuery.queryKey, approved);
      await approvalQuery.refetch();
    } catch (error) {
      setActionError(localizeError(error, t, {
        fallbackKey: "dispatch.importApprovalError",
        fallback: "Kunde inte godkänna planen. Försök igen.",
      }));
    } finally {
      setIsApproving(false);
    }
  }, [
    approvalQuery,
    canWrite,
    isApproving,
    liveRoutes,
    mapping.canApprove,
    queryClient,
    requestedPlanId,
    t,
  ]);

  if (!requestedPlanId) return null;

  const actionState = getImportApprovalActionState(mapping.state, canWrite);
  const statusMessage = (() => {
    if (actionState === "readOnly") {
      return copy(
        t,
        "dispatch.importApprovalReadOnly",
        "Du har läsrättighet. Planen kan granskas, men godkännande och utskick kräver behörighet.",
      );
    }
    switch (mapping.state) {
      case "notProtected":
        return copy(
          t,
          "dispatch.importApprovalNotProtected",
          "Den valda planen är inte ett skyddat importutkast och kan därför inte godkännas här.",
        );
      case "noEligibleRoutes":
        return copy(
          t,
          "dispatch.importApprovalNoEligiblePlan",
          "Ingen skyddad, aktuell plan med utskickbara rutter hittades.",
        );
      case "missingDriver":
        return copy(
          t,
          "dispatch.importApprovalMissingDriver",
          "Planen saknar en aktuell, auktoritativ förare för minst en rutt.",
        );
      case "stale":
        return copy(
          t,
          "dispatch.importApprovalStale",
          "Planen eller godkännandet är inaktuellt. Ladda om och granska planen igen.",
        );
      case "awaitingApproval":
        return copy(
          t,
          "dispatch.importApprovalAwaiting",
          "Planen är sparad och väntar på ditt uttryckliga godkännande.",
        );
      case "exact":
        return copy(
          t,
          "dispatch.importApprovalExact",
          "Planen är godkänd för utskick. Utskicket startar först när du väljer Skicka.",
        );
    }
  })();

  const routeListTitle = copy(
    t,
    "dispatch.importApprovalRouteList",
    "Rutter i vald plan",
  );
  const routeNumber = (index: number) => copy(
    t,
    "dispatch.importRouteNumber",
    `Rutt ${index + 1}`,
    { number: index + 1 },
  );
  const isReadOnly = actionState === "readOnly";
  const showApprovalLoading = actionState !== "readOnly" && approvalQuery.isLoading;
  const showApprovalError = actionState !== "readOnly" && Boolean(approvalQuery.error);
  const shouldRenderDispatch = actionState === "exact" && mapping.assignedRoutes.length > 0;
  const dispatchKey = mapping.assignedRoutes
    .map((route) => `${route.routeId}:${route.planRevision}:${route.driverId}`)
    .join("|");

  return (
    <section
      className="shrink-0 max-h-[52vh] overflow-y-auto border-b border-border bg-background px-3 py-3"
      data-testid="dispatch-import-plan-approval"
      aria-label={copy(
        t,
        "dispatch.importApprovalTitle",
        "Godkänn importplan för utskick",
      )}
    >
      <Card className="mx-auto max-w-5xl border-primary/20 bg-card/80">
        <div className="flex flex-wrap items-start justify-between gap-3 p-4 pb-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <ClipboardCheck className="h-5 w-5 shrink-0 text-primary" />
              <h2 className="text-base font-semibold">
                {copy(
                  t,
                  "dispatch.importApprovalTitle",
                  "Godkänn importplan för utskick",
                )}
              </h2>
              <Badge variant="outline" data-testid="dispatch-selected-plan">
                {copy(t, "dispatch.importSelectedPlan", "Vald plan")}: {planId}
              </Badge>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              {copy(
                t,
                "dispatch.importApprovalDescription",
                "Kontrollera planens aktuella rutter. Godkännande och utskick är två separata åtgärder.",
              )}
            </p>
          </div>
          {mapping.exact && (
            <Badge variant="default" data-testid="dispatch-import-plan-approved">
              <CheckCircle2 className="mr-1.5 h-3.5 w-3.5" />
              {copy(t, "dispatch.importApprovalApproved", "Godkänd")}
            </Badge>
          )}
        </div>

        {showValidationSuccess && (
          <Alert className="mx-4 mb-3 border-emerald-500/30 bg-emerald-500/5 text-emerald-700 dark:text-emerald-300">
            <CheckCircle2 className="h-4 w-4" />
            <AlertTitle>
              {copy(
                t,
                "dispatch.importValidationSuccess",
                "Planen är validerad och sparad",
              )}
            </AlertTitle>
            <AlertDescription>
              {copy(
                t,
                "dispatch.importValidationSuccessDescription",
                "Granska den valda planen här innan du godkänner utskick.",
              )}
            </AlertDescription>
          </Alert>
        )}

        <div className="px-4 pb-4">
          <div className="rounded-lg border border-border/70 bg-muted/20 p-3">
            <div className="mb-2 flex items-center justify-between gap-2">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
                {routeListTitle}
              </h3>
              <span className="text-xs tabular-nums text-muted-foreground">
                {routeNames.length}
              </span>
            </div>
            {routeNames.length > 0 ? (
              <ul className="grid gap-2 sm:grid-cols-2">
                {routeNames.map((route, index) => (
                  <li
                    key={route.id}
                    className="flex min-w-0 items-center justify-between gap-3 rounded-md border border-border/60 bg-background/70 px-3 py-2"
                    data-testid={`dispatch-import-plan-route-${route.id}`}
                  >
                    <span className="min-w-0 truncate text-sm font-medium" title={route.name}>
                      {route.name || routeNumber(index)}
                    </span>
                    <span className="shrink-0 text-xs text-muted-foreground">
                      {copy(
                        t,
                        "dispatch.importRouteStops",
                        "{{count}} stopp",
                        { count: route.totalStops },
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-sm text-muted-foreground">
                {copy(
                  t,
                  "dispatch.importApprovalNoRoutes",
                  "Inga aktuella rutter kunde hittas för planen.",
                )}
              </p>
            )}
          </div>

          {isReadOnly && (
            <Alert className="mt-3">
              <LockKeyhole className="h-4 w-4" />
              <AlertDescription>
                {copy(
                  t,
                  "dispatch.importApprovalReadOnly",
                  "Din roll är skrivskyddad. Du kan granska planen, men inte godkänna eller skicka den.",
                )}
              </AlertDescription>
            </Alert>
          )}

          {showApprovalLoading && (
            <div className="mt-3 flex items-center gap-2 text-sm text-muted-foreground" role="status">
              <Loader2 className="h-4 w-4 animate-spin" />
              {copy(
                t,
                "dispatch.importApprovalLoading",
                "Kontrollerar planens aktuella godkännande…",
              )}
            </div>
          )}

          {showApprovalError && (
            <Alert className="mt-3" variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                {localizeError(approvalQuery.error, t, {
                  fallbackKey: "dispatch.importApprovalError",
                  fallback: "Kunde inte läsa planens godkännande. Försök igen.",
                })}
              </AlertDescription>
            </Alert>
          )}

          {!showApprovalLoading && !showApprovalError && !isReadOnly && (
            <Alert
              className={`mt-3 ${
                mapping.exact
                  ? "border-emerald-500/30 bg-emerald-500/5"
                  : mapping.state === "awaitingApproval"
                    ? "border-amber-500/30 bg-amber-500/5"
                    : "border-destructive/30 bg-destructive/5"
              }`}
              variant={mapping.state === "stale" || mapping.state === "missingDriver" ? "destructive" : "default"}
            >
              {mapping.exact ? (
                <CheckCircle2 className="h-4 w-4" />
              ) : (
                <AlertTriangle className="h-4 w-4" />
              )}
              <AlertDescription>{statusMessage}</AlertDescription>
            </Alert>
          )}

          {actionError && (
            <Alert className="mt-3" variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>{actionError}</AlertDescription>
            </Alert>
          )}

          {!showApprovalLoading
            && !showApprovalError
            && mapping.state === "awaitingApproval"
            && canWrite && (
              <div className="mt-3 flex flex-wrap items-center justify-between gap-3">
                <p className="text-xs text-muted-foreground">
                  {copy(
                    t,
                    "dispatch.importApprovalActionHint",
                    "Godkänn först. Utskicket visas därefter som en separat åtgärd.",
                  )}
                </p>
                <Button
                  type="button"
                  onClick={() => void handleApprove()}
                  disabled={isApproving}
              data-testid="planning-draft-approve"
                >
                  {isApproving ? (
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  ) : (
                    <ClipboardCheck className="mr-2 h-4 w-4" />
                  )}
                  {isApproving
                    ? copy(t, "dispatch.importApprovalApproving", "Godkänner…")
                    : copy(t, "dispatch.importApprovalApproveButton", "Godkänn plan")}
                </Button>
              </div>
            )}
        </div>
      </Card>

      {shouldRenderDispatch && (
        <div className="mx-auto mt-3 max-w-5xl" data-testid="dispatch-import-plan-send">
          <div className="mb-2 flex items-center gap-2 px-1 text-xs font-semibold uppercase tracking-wide text-muted-foreground">
            <Send className="h-3.5 w-3.5" />
            {copy(
              t,
              "dispatch.importSendTitle",
              "Separat utskick",
            )}
          </div>
          <Step7Dispatch
            key={`${planId}:${dispatchKey}`}
            routes={mapping.assignedRoutes}
            onAllPublished={() => {
              void approvalQuery.refetch();
              void queryClient.invalidateQueries({ queryKey: ["/api/routes"] });
            }}
            onFinish={onContinueLive}
          />
        </div>
      )}
    </section>
  );
}