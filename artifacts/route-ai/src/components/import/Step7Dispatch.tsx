import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  getRoute,
  getRoutePreflight,
  useDispatchRoute,
  useResendRouteSms,
  type Route,
} from "@workspace/api-client-react";
import {
  AlertTriangle,
  CheckCircle2,
  Loader2,
  Map,
  MessageSquareWarning,
  Radio,
  RefreshCw,
  Send,
  Truck,
} from "lucide-react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import type {
  ImportAssignedRoute,
  ImportDispatchResult,
  ImportResendResult,
} from "./types";
import { getApiErrorMessage } from "./types";
import { TrustedLocalizedError } from "@/lib/localize-error";
import { matchesPlanRevision } from "@/lib/dispatch-reconciliation";
import type { PlanningMetadata } from "./Step6Vehicles";

interface Step7DispatchProps {
  routes: ImportAssignedRoute[];
  unplannedCount?: number;
  planningMetadata?: PlanningMetadata;
  onFinish: () => void;
  onAllPublished: () => void;
  onRouteChanged?: (routeId: string) => void | Promise<void>;
}

type DispatchStatus = "pending" | "sending" | "published" | "sent" | "sms_failed" | "failed";

interface DispatchState {
  status: DispatchStatus;
  dispatchSucceeded: boolean;
  smsStatus: "unknown" | "sent" | "failed" | "skipped";
  result?: ImportDispatchResult | ImportResendResult;
  message?: string;
}

const CURRENT_HANDOFF_STATUSES = new Set<Route["handoffStatus"]>([
  "sent",
  "received",
  "opened",
  "accepted",
  "rejected",
]);

function hasCurrentDispatch(route: Route): boolean {
  return (
    CURRENT_HANDOFF_STATUSES.has(route.handoffStatus)
    && route.handoffVersion === route.planRevision
    && Boolean(route.handoffDriverId)
  );
}

export function Step7Dispatch({
  routes,
  unplannedCount = 0,
  planningMetadata,
  onFinish,
  onAllPublished,
  onRouteChanged,
}: Step7DispatchProps) {
  const { t } = useTranslation();
  const [states, setStates] = useState<Record<string, DispatchState>>(() =>
    Object.fromEntries(routes.map((route) => [
      route.routeId,
      {
        status: "pending",
        dispatchSucceeded: false,
        smsStatus: "unknown",
      },
    ])),
  );
  const [isReconciling, setIsReconciling] = useState(true);
  const hasReportedPublished = useRef(false);
  const dispatchRoute = useDispatchRoute();
  const resendSms = useResendRouteSms();
  const noRoutes = routes.length === 0;

  const reconcileRoute = useCallback(async (route: ImportAssignedRoute): Promise<boolean> => {
    const actual = await getRoute(route.routeId);
    if (!matchesPlanRevision(actual, route.planRevision)) {
      throw new TrustedLocalizedError(t("import.routePlanChanged"));
    }
    if (!hasCurrentDispatch(actual)) return false;
    setStates((previous) => {
      const current = previous[route.routeId];
      if (current?.dispatchSucceeded) return previous;
      return {
        ...previous,
        [route.routeId]: {
          ...current,
          status: "published",
          dispatchSucceeded: true,
          smsStatus: current?.smsStatus ?? "unknown",
          message: t("import.dispatchSmsUnknown"),
        },
      };
    });
    return true;
  }, [t]);

  useEffect(() => {
    let cancelled = false;
    const loadCurrentHandoffs = async () => {
      setIsReconciling(true);
      await Promise.all(routes.map(async (route) => {
        try {
          if (!cancelled) await reconcileRoute(route);
        } catch {
          // A failed read leaves the route pending; publishing remains explicit.
        }
      }));
      if (!cancelled) setIsReconciling(false);
    };
    void loadCurrentHandoffs();
    return () => {
      cancelled = true;
    };
  }, [reconcileRoute, routes]);

  const isSending = isReconciling || Object.values(states).some((state) => state.status === "sending");
  const allSmsSent = routes.length > 0
    && routes.every((route) => states[route.routeId]?.smsStatus === "sent");
  const allPublished = routes.length > 0
    && routes.every((route) => {
      return states[route.routeId]?.dispatchSucceeded;
    });
  const sentCount = routes.filter((route) => states[route.routeId]?.smsStatus === "sent").length;

  const routesToPublish = useMemo(
    () => routes.filter((route) => {
      return !states[route.routeId]?.dispatchSucceeded;
    }),
    [routes, states],
  );

  useEffect(() => {
    if (!allPublished) {
      hasReportedPublished.current = false;
      return;
    }
    if (hasReportedPublished.current) return;
    hasReportedPublished.current = true;
    onAllPublished();
  }, [allPublished, onAllPublished]);

  const publishOne = async (route: ImportAssignedRoute, isResend = false, sendSms = true) => {
    setStates((previous) => ({
      ...previous,
      [route.routeId]: {
        ...previous[route.routeId],
        status: "sending",
        dispatchSucceeded: previous[route.routeId]?.dispatchSucceeded ?? false,
        smsStatus: previous[route.routeId]?.smsStatus ?? "unknown",
      },
    }));

    try {
      // Always reconcile first. A lost dispatch response must not cause a
      // second dispatch that resets an acknowledgement back to "sent".
      const alreadyPublished = await reconcileRoute(route);
      if (alreadyPublished) {
        if (!isResend) {
          await onRouteChanged?.(route.routeId);
          return;
        }
        const current = await getRoute(route.routeId);
        if (!matchesPlanRevision(current, route.planRevision) || !current.handoffDriverId) {
          throw new TrustedLocalizedError(t("import.routePlanChanged"));
        }
        const resendResult = await resendSms.mutateAsync({
          id: route.routeId,
          data: { driverId: current.handoffDriverId },
        });
        const smsSent = resendResult.status === "sent";
        setStates((previous) => ({
          ...previous,
          [route.routeId]: {
            ...previous[route.routeId],
            status: smsSent ? "sent" : "sms_failed",
            dispatchSucceeded: true,
            smsStatus: smsSent ? "sent" : "failed",
            result: resendResult,
            message: resendResult.message,
          },
        }));
        await onRouteChanged?.(route.routeId);
        return;
      }
      if (isResend) {
        throw new Error(t("import.dispatchNotAvailableForResend"));
      }

      const preflight = await getRoutePreflight(route.routeId);
      if (preflight.planRevision !== route.planRevision) {
        throw new TrustedLocalizedError(t("import.routePlanChanged"));
      }
      if (!preflight.ready || !preflight.driverId) {
        throw new TrustedLocalizedError(t("import.routePublishFailed"));
      }
      const result = await dispatchRoute.mutateAsync({
        id: route.routeId,
        data: { driverId: preflight.driverId, sendSms },
      });
      const smsSent = result.sms.status === "sent";
      setStates((previous) => ({
        ...previous,
        [route.routeId]: {
          ...previous[route.routeId],
          status: result.sms.status === "skipped" ? "published" : smsSent ? "sent" : "sms_failed",
          dispatchSucceeded: true,
          smsStatus: result.sms.status === "skipped" ? "skipped" : smsSent ? "sent" : "failed",
          result,
          message: result.sms.message,
        },
      }));
      await onRouteChanged?.(route.routeId);
    } catch (error) {
      // If the POST response was lost after the backend committed, preserve
      // dispatch success and expose only the unresolved SMS state.
      try {
        if (!isResend && await reconcileRoute(route)) {
          await onRouteChanged?.(route.routeId);
          return;
        }
      } catch {
        // Keep the original error below when reconciliation also fails.
      }
      setStates((previous) => ({
        ...previous,
        [route.routeId]: {
          ...previous[route.routeId],
          status: isResend && previous[route.routeId]?.dispatchSucceeded
            ? "sms_failed"
            : "failed",
          dispatchSucceeded: previous[route.routeId]?.dispatchSucceeded ?? false,
          smsStatus: isResend ? "failed" : previous[route.routeId]?.smsStatus ?? "unknown",
          message: getApiErrorMessage(
            error,
            new TrustedLocalizedError(
              t(isResend ? "import.routeSmsResendFailed" : "import.routePublishFailed"),
            ),
          ),
        },
      }));
      await onRouteChanged?.(route.routeId);
    }
  };

  const publishAll = async () => {
    for (const route of routesToPublish) {
      await publishOne(route);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-semibold text-foreground">
            {noRoutes ? t("import.noRoutesToPublish") : t("import.publishToDrivers")}
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            {noRoutes
              ? t("import.allStopsUnplanned")
              : t("import.publishDescription")}
          </p>
        </div>
        <Badge variant={allSmsSent ? "default" : "secondary"}>
          {t("import.smsAcceptedCount", { sent: sentCount, total: routes.length })}
        </Badge>
      </div>

      {(planningMetadata?.customerReference || planningMetadata?.sharedInstructions) && (
        <Card className="space-y-3 p-4">
          {planningMetadata.customerReference && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t("createRoute.customerReference")}
              </p>
              <p className="mt-1 text-sm">{planningMetadata.customerReference}</p>
            </div>
          )}
          {planningMetadata.sharedInstructions && (
            <div>
              <p className="text-xs font-medium text-muted-foreground">
                {t("import.sharedInstructions")}
              </p>
              <p className="mt-1 whitespace-pre-wrap text-sm">
                {planningMetadata.sharedInstructions}
              </p>
            </div>
          )}
        </Card>
      )}

      {noRoutes && (
        <Alert>
          <AlertTriangle className="h-4 w-4" />
          <AlertDescription>
            {t("import.unplannedDispatchDescription", { count: unplannedCount })}
          </AlertDescription>
        </Alert>
      )}

      {!allSmsSent && routes.some((route) => states[route.routeId]?.status === "sms_failed") && (
        <Alert>
          <MessageSquareWarning className="h-4 w-4" />
          <AlertDescription>
            {t("import.smsFailedWarning")}
          </AlertDescription>
        </Alert>
      )}

      <div className="space-y-3">
        {routes.map((route, index) => {
          const state = states[route.routeId] ?? {
            status: "pending" as const,
            dispatchSucceeded: false,
            smsStatus: "unknown" as const,
          };
          const successful = state.dispatchSucceeded && state.smsStatus === "sent";
          const warning = state.status === "sms_failed"
            || (state.dispatchSucceeded && state.smsStatus === "unknown");
          const failed = state.status === "failed";

          return (
            <Card
              key={route.routeId}
              data-testid={`planning-draft-dispatch-${route.routeId}`}
              className={
                successful
                  ? "border-emerald-500/30"
                  : warning
                    ? "border-amber-500/40"
                    : failed
                      ? "border-destructive/40"
                      : ""
              }
            >
              <div className="flex flex-wrap items-center gap-4 p-4">
                <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-full ${
                  successful
                    ? "bg-emerald-500/10 text-emerald-600"
                    : warning
                      ? "bg-amber-500/10 text-amber-600"
                      : failed
                        ? "bg-destructive/10 text-destructive"
                        : "bg-muted text-muted-foreground"
                }`}>
                  {state.status === "sending"
                    ? <Loader2 className="h-5 w-5 animate-spin" />
                    : successful
                      ? <CheckCircle2 className="h-5 w-5" />
                      : warning || failed
                        ? <AlertTriangle className="h-5 w-5" />
                        : <Truck className="h-5 w-5" />}
                </div>

                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-2">
                    <p className="font-medium">{route.name || t("import.routeNumber", { number: index + 1 })}</p>
                    <Badge variant="outline">{t("import.stopCount", { count: route.stopCount })}</Badge>
                    <Badge variant="outline">{t("import.distanceKm", { distance: route.totalDistanceKm.toFixed(1) })}</Badge>
                  </div>
                  <p className="mt-1 text-xs text-muted-foreground">
                     {state.smsStatus === "skipped" ? "Publicerad utan SMS" : state.status === "published"
                       ? t("import.routePublishedSmsUnknown")
                       : state.status === "sent"
                         ? t("import.routePublishedSmsAccepted")
                         : state.status === "sms_failed"
                           ? t("import.routePublishedSmsFailed")
                           : state.status === "failed"
                             ? t("import.routePublishFailed")
                             : state.status === "sending"
                               ? t("import.routePublishing")
                               : t("import.routeNotPublished")}
                    {state.message ? ` — ${state.message}` : ""}
                  </p>
                </div>

                {(warning || failed || (!state.dispatchSucceeded && state.status !== "sending")) && (
                  <Button
                    variant="outline"
                    size="sm"
                   data-testid={`planning-draft-${warning ? "resend" : "send"}-${route.routeId}`}
                    onClick={() => void publishOne(route, warning)}
                    disabled={isSending}
                  >
                    <RefreshCw className="mr-2 h-3.5 w-3.5" />
                     {warning
                       ? t("import.retrySms")
                       : failed
                         ? t("import.retryPublish")
                         : t("import.publishAndSend")}
                  </Button>
                )}
              </div>
            </Card>
          );
        })}
      </div>

      {allPublished && (
        <Card className="border-emerald-500/30 bg-emerald-500/5 p-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-emerald-500/15 text-emerald-600">
            <Radio className="h-6 w-6" />
          </div>
          <h3 className="font-semibold">{t("import.allRoutesPublished")}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            {allSmsSent
               ? t("import.allPublishedSmsAccepted")
               : t("import.allPublishedSmsWarning")}
          </p>
        </Card>
      )}

      <div className="flex items-center justify-end gap-3 border-t pt-5">
        {!noRoutes && !allPublished && (
          <Button variant="outline" disabled={isSending}
            onClick={async () => {
              for (const route of routes) {
                if (!states[route.routeId]?.dispatchSucceeded) await publishOne(route, false, false);
              }
            }}>
            Publicera till föraren utan SMS
          </Button>
        )}
        {!noRoutes && !allPublished && (
          <Button onClick={() => void publishAll()} disabled={isSending || routes.length === 0}>
            {isSending ? (
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
            ) : (
              <Send className="mr-2 h-4 w-4" />
            )}
            {routesToPublish.length === routes.length
              ? t("import.publishAndSend")
              : t("import.retryRemainingSms")}
          </Button>
        )}
        <Button onClick={onFinish} data-testid="planning-draft-open-map">
          <Map className="mr-2 h-4 w-4" />
          {noRoutes ? t("import.openDispatch") : t("import.openMap")}
        </Button>
      </div>
    </div>
  );
}