import React, { useCallback, useEffect, useState, useMemo, useRef } from "react";
import {
  View,
  Text,
  StyleSheet,
  FlatList,
  Pressable,
  ActivityIndicator,
  RefreshControl,
  Platform,
  Alert,
  Modal,
  TextInput,
  Linking,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useListRouteMessages } from "@workspace/api-client-react";
import { router, useLocalSearchParams } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useTabBarHeight } from "@/hooks/useTabBarHeight";
import { routeIdentityLine } from "@/lib/route-identity";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useSelectedRoute } from "@/context/SelectedRouteContext";
import { useDriverAssistance } from "@/context/DriverAssistanceContext";
import {
  api,
  isAuthError,
  ensureRouteExecutionForWork,
  type Stop,
  type Route,
  type Vehicle,
  type RouteIncident,
  type RouteIncidentCategory,
} from "@/lib/api";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useGpsTracking } from "@/hooks/useGpsTracking";
import { useT } from "@/lib/i18n";
import {
  enqueueStopStatusUpdate,
  setCachedData,
  getCachedData,
} from "@/lib/offline-queue";
import { executionEventTypeForStatus } from "@/lib/offline-queue-migration";
import { hasUnresolvedTrackingStops } from "@/lib/tracking-lifecycle";
import { mergeHandoffResponse } from "@/lib/handoff-cache";
import { localizeError } from "@/lib/error-localizer";
import { StopCard, ServiceStopCard, PdStopCard } from "@/components/route/StopCards";
import { TakeStopNow } from "@/components/TakeStopNow";
import { useOfflineQueueStatus } from "@/hooks/useOfflineQueueStatus";
import { Disclosure } from "@/components/route/Disclosure";
import { SyncSummary } from "@/components/route/SyncSummary";

const STATUS_CONFIG: Record<string, { color: string; icon: string; label: string }> = {
  pending: { color: Colors.light.textTertiary, icon: "clock", label: "pending" },
  in_progress: { color: Colors.light.warning, icon: "arrow-right-circle", label: "in_progress" },
  completed: { color: Colors.light.success, icon: "check-circle", label: "completed" },
  failed: { color: Colors.light.danger, icon: "x-circle", label: "failed" },
  skipped: { color: Colors.light.warning, icon: "skip-forward", label: "skipped" },
};
const INCIDENT_CATEGORIES: RouteIncidentCategory[] = [
  "traffic",
  "vehicle_issue",
  "accident",
  "customer_unavailable",
  "access_problem",
  "weather",
  "safety",
  "other",
];

function isHttpsUrl(value: string | null | undefined): value is string {
  if (!value) return false;
  try {
    return new URL(value).protocol === "https:";
  } catch {
    return false;
  }
}

/** Returns true when the stop has a separate pickup location */
function isPdStop(stop: Stop): boolean {
  return typeof stop.pickupAddress === "string" && stop.pickupAddress.trim().length > 0;
}

/** Returns true if this is a field service job */
function isServiceStop(stop: Stop): boolean {
  return stop.jobType === "field_service";
}


function formatTime(val: string) {
  if (val.includes("T")) {
    return new Date(val).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  }
  return val.slice(0, 5);
}

function RoutePlanningCard({ route }: { route: Route }) {
  const c = Colors.light;
  const { lang } = useT();
  const summary = route.planningSummary;
  const snapshot = route.optimizationPlanningSnapshot;
  const travelReserveMin = route.workdaySummary?.travelReserveMin;
  const totalStopReserveMin = route.workdaySummary?.stopReserveMin;
  const hasTravelReserveMinutes = typeof travelReserveMin === "number";
  const hasStopReserveMinutes = typeof totalStopReserveMin === "number";
  const hasReserveSummary = Boolean(summary || snapshot || hasTravelReserveMinutes || hasStopReserveMinutes);
  const hasReference = Boolean(route.customerReference?.trim());
  const hasInstructions = Boolean(route.sharedInstructions?.trim());

  if (!hasReference && !hasInstructions && !hasReserveSummary) {
    return null;
  }

  const objective = summary?.objective ?? snapshot?.objective;
  const objectiveLabel = objective
    ? ({
        balanced: lang === "sv" ? "Balanserad arbetstid" : "Balanced working time",
        shortest: lang === "sv" ? "Kortast körsträcka" : "Shortest driving distance",
        geographic: lang === "sv" ? "Geografisk sammanhållning" : "Geographic cohesion",
        areas_worktime: lang === "sv" ? "Sammanhållna områden och arbetstid" : "Cohesive areas and working time",
        minimize_vehicles: lang === "sv" ? "Färre fordon" : "Fewer vehicles",
      } as const)[objective]
    : null;
  const travelReservePercent = summary?.travelReservePercent ?? snapshot?.travelReservePercent;
  const stopReserveMin = summary?.stopReserveMin ?? snapshot?.stopReserveMin;
  const mandatoryUnplannedCount = summary?.mandatoryUnplannedStopIds?.length ?? 0;
  const reserveLabel = lang === "sv" ? "Reservtid" : "Planning reserve";
  const travelLabel = lang === "sv" ? "Körreserv" : "Travel reserve";
  const stopLabel = lang === "sv" ? "Stoppreserv" : "Stop reserve";

  return (
    <View style={[styles.timelineCard, { backgroundColor: c.surface, borderColor: c.border }]}>
      <View style={styles.handoffTitleRow}>
        <Feather name="clipboard" size={19} color={c.primary} />
        <Text style={[styles.timelineHeaderTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
          {lang === "sv" ? "Planeringsunderlag" : "Planning details"}
        </Text>
      </View>

      {hasReference && (
        <View style={{ gap: 2 }}>
          <Text style={[styles.summaryStatLabel, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
            {lang === "sv" ? "Kundreferens" : "Customer reference"}
          </Text>
          <Text style={{ color: c.text, fontFamily: "Inter_600SemiBold" }}>
            {route.customerReference}
          </Text>
        </View>
      )}

      {hasInstructions && (
        <View style={[styles.routeInstructions, { backgroundColor: c.primary + "0D", borderColor: c.primary + "35" }]}>
          <Text style={[styles.summaryStatLabel, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>
            {lang === "sv" ? "Gemensamma chaufförsinstruktioner" : "Shared driver instructions"}
          </Text>
          <Text style={[styles.routeInstructionsText, { color: c.text, fontFamily: "Inter_400Regular" }]}>
            {route.sharedInstructions}
          </Text>
        </View>
      )}

      {hasReserveSummary && (
        <View style={{ gap: 8 }}>
          <Text style={[styles.summaryStatLabel, { color: c.textSecondary, fontFamily: "Inter_600SemiBold" }]}>
            {reserveLabel}
          </Text>
          {objectiveLabel && (
            <Text style={{ color: c.text, fontFamily: "Inter_500Medium" }}>
              {lang === "sv" ? "Mål: " : "Objective: "}
              {objectiveLabel}
            </Text>
          )}
          <View style={styles.summaryGrid}>
            {typeof travelReservePercent === "number" && (
              <View style={[styles.summaryStat, { backgroundColor: c.background, borderColor: c.border }]}>
                <Text style={[styles.summaryStatLabel, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
                  {travelLabel}
                </Text>
                <Text style={[styles.summaryStatValue, { color: c.text, fontFamily: "Inter_700Bold" }]}>
                  +{travelReservePercent}%
                </Text>
                {hasTravelReserveMinutes && (
                  <Text style={{ color: c.textSecondary, fontFamily: "Inter_400Regular", fontSize: 12 }}>
                    {travelReserveMin} {lang === "sv" ? "min totalt" : "min total"}
                  </Text>
                )}
              </View>
            )}
            {typeof stopReserveMin === "number" && (
              <View style={[styles.summaryStat, { backgroundColor: c.background, borderColor: c.border }]}>
                <Text style={[styles.summaryStatLabel, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
                  {stopLabel}
                </Text>
                <Text style={[styles.summaryStatValue, { color: c.text, fontFamily: "Inter_700Bold" }]}>
                  +{stopReserveMin} {lang === "sv" ? "min/stopp" : "min/stop"}
                </Text>
                {hasStopReserveMinutes && (
                  <Text style={{ color: c.textSecondary, fontFamily: "Inter_400Regular", fontSize: 12 }}>
                    {totalStopReserveMin} {lang === "sv" ? "min totalt" : "min total"}
                  </Text>
                )}
              </View>
            )}
          </View>
          {mandatoryUnplannedCount > 0 && (
            <Text style={{ color: c.danger, fontFamily: "Inter_600SemiBold", fontSize: 12 }}>
              {lang === "sv"
                ? `${mandatoryUnplannedCount} obligatoriskt stopp kunde inte planeras.`
                : `${mandatoryUnplannedCount} mandatory stop${mandatoryUnplannedCount === 1 ? "" : "s"} could not be planned.`}
            </Text>
          )}
        </View>
      )}
    </View>
  );
}

function WorkdayTimelineCard({ route }: { route: Route }) {
  const c = Colors.light;
  const { t } = useT();

  if (!route.workdaySummary || !route.workdayTimeline) {
    return null;
  }

  const { workdaySummary: summary, workdayTimeline: timeline, depotSnapshot } = route;

  const Stat = ({ label, min, color }: { label: string; min: number; color?: string }) => (
    <View style={[styles.summaryStat, { backgroundColor: c.background, borderColor: c.border }]}>
      <Text style={[styles.summaryStatLabel, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]} numberOfLines={1}>{label}</Text>
      <Text style={[styles.summaryStatValue, { color: color || c.text, fontFamily: "Inter_700Bold" }]}>{min} {t("common.min")}</Text>
    </View>
  );

  return (
    <View style={[styles.timelineCard, { backgroundColor: c.surface, borderColor: c.border }]}>
      <Text style={[styles.timelineHeaderTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
        {t("routes.workdaySummary")}
      </Text>

      <View style={styles.summaryGrid}>
        <Stat label={t("routes.plannedWorkday")} min={summary.totalMin} />
        <Stat label={t("routes.shift")} min={summary.shiftMin} />
        {summary.nonReturnDrivingMin > 0 && <Stat label={t("routes.timeline.driving")} min={summary.nonReturnDrivingMin} />}
        {summary.serviceMin > 0 && <Stat label={t("routes.timeline.service")} min={summary.serviceMin} />}
        {summary.waitingMin > 0 && <Stat label={t("routes.timeline.waiting")} min={summary.waitingMin} />}
        {summary.breakMin > 0 && <Stat label={t("routes.timeline.break")} min={summary.breakMin} />}
        {summary.returnMin > 0 && <Stat label={t("routes.timeline.return")} min={summary.returnMin} />}
        {summary.marginMin > 0 && <Stat label={t("routes.margin")} min={summary.marginMin} />}
        {summary.overtimeMin > 0 && <Stat label={t("routes.overtime")} min={summary.overtimeMin} color={c.danger} />}
      </View>

      <View style={styles.timelineList}>
        {timeline.map((item, idx) => {
          const isFirst = idx === 0;
          const isLast = idx === timeline.length - 1;

          let icon = "clock";
          let color = c.textSecondary;
          let label = t(`routes.timeline.${item.type}`);
          let sublabel = "";

          if (item.type === "depot_start") {
             icon = "home";
             color = c.primary;
             if (depotSnapshot?.start?.address) sublabel = depotSnapshot.start.address;
          } else if (item.type === "depot_end") {
             icon = "flag";
             color = c.primary;
             if (depotSnapshot?.end?.address) sublabel = depotSnapshot.end.address;
          } else if (item.type === "driving" || item.type === "return") {
             icon = "navigation";
             color = c.info;
             if (item.distanceKm) sublabel = `${item.distanceKm} km`;
          } else if (item.type === "service") {
             icon = "tool";
             color = c.warning;
          } else if (item.type === "break") {
             icon = "coffee";
             color = c.accent;
          } else if (item.type === "charging") {
             icon = "battery-charging";
             color = c.success;
          } else if (item.type === "waiting") {
             icon = "watch";
          }

          return (
            <View key={idx} style={styles.timelineRow}>
              <View style={styles.timelineTimeCol}>
                 <Text style={[styles.timelineTime, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
                   {formatTime(item.startAt)}
                 </Text>
                 <Text style={[styles.timelineDuration, { color: c.textTertiary, fontFamily: "Inter_400Regular" }]}>
                   {item.durationMin} {t("common.min")}
                 </Text>
              </View>
              <View style={styles.timelineTrack}>
                <View style={[styles.timelineTrackLine, { backgroundColor: c.border, opacity: isFirst ? 0 : 1 }]} />
                <View style={[styles.timelineDot, { backgroundColor: color + "20" }]}>
                  <Feather name={icon as any} size={12} color={color} />
                </View>
                <View style={[styles.timelineTrackLine, { backgroundColor: c.border, opacity: isLast ? 0 : 1 }]} />
              </View>
              <View style={styles.timelineContent}>
                 <Text style={[styles.timelineItemLabel, { color: c.text, fontFamily: "Inter_500Medium" }]}>
                   {label}
                 </Text>
                 {!!sublabel && (
                   <Text style={[styles.timelineItemSub, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]} numberOfLines={1}>
                     {sublabel}
                   </Text>
                 )}
              </View>
            </View>
          );
        })}
      </View>
    </View>
  );
}

export default function RoutesTab() {
  const c = Colors.light;
  const { user, driver, isAdmin } = useAuth();
  const {
    isAssisting,
    assistedDriver,
    selection: assistanceSelection,
    selectAssistance,
    clearAssistance,
  } = useDriverAssistance();
  const operatingDriver = assistedDriver ?? driver;
  const canOperate = !isAdmin || isAssisting;
  const gpsOwner = useMemo(
    () => (user ? { userId: user.id, organizationId: user.organizationId } : null),
    [user?.id, user?.organizationId],
  );
  const { t, lang } = useT();
  const { routeId, review, assist } = useLocalSearchParams<{
    routeId?: string | string[];
    review?: string | string[];
    assist?: string | string[];
  }>();
  const requestedRouteId = Array.isArray(routeId) ? routeId[0] : routeId;
  const requestedReview = Array.isArray(review) ? review[0] : review;
  const requestedAssistanceSelector = Array.isArray(assist) ? assist[0] : assist;
  const insets = useSafeAreaInsets();
  const tabBarHeight = useTabBarHeight();
  const queryClient = useQueryClient();
  const { isOnline } = useNetworkStatus();
  const { activeRoutes, activeRoute, setSelectedRouteId, routesLoading, routesError, refetchRoutes, routeScopeKey } = useSelectedRoute();
  const routes = activeRoutes;
  const [showRouteSelector, setShowRouteSelector] = useState(false);
  const [showAssistanceSelector, setShowAssistanceSelector] = useState(false);
  const [handoffDialog, setHandoffDialog] = useState<"accept" | "reject" | null>(null);
  const [rejectionReason, setRejectionReason] = useState("");
  const [showDeviation, setShowDeviation] = useState(false);
  const [deviationCategory, setDeviationCategory] = useState<RouteIncidentCategory>("traffic");
  const [deviationComment, setDeviationComment] = useState("");
  const [deviationEvidence, setDeviationEvidence] = useState("");
  const [skipStopId, setSkipStopId] = useState<string | null>(null);
  const [skipReason, setSkipReason] = useState<string | null>(null);
  const [skipComment, setSkipComment] = useState("");
  const [trackingSummary, setTrackingSummary] = useState<import("@/lib/api").RouteTrackingSummary | null>(null);
  const [showTrackingSummary, setShowTrackingSummary] = useState(false);
  const [reviewRequired, setReviewRequired] = useState(requestedReview === "1");
  const knownPlanRevision = useRef<number | null>(null);
  const handoffUpdatesInFlight = useRef<Set<string>>(new Set());

  const { data: vehicles } = useQuery({
    queryKey: ["vehicles"],
    queryFn: () => api.getVehicles(),
  });
  const { data: assistanceAssignments, isLoading: assistanceLoading } = useQuery({
    queryKey: ["driver-assistance-assignments"],
    queryFn: () => api.getDriverAssistanceAssignments(),
    enabled: isAdmin && showAssistanceSelector && isOnline,
    staleTime: 0,
  });

  useEffect(() => {
    if (isAdmin && requestedAssistanceSelector === "select") {
      setShowAssistanceSelector(true);
      router.setParams({ assist: undefined });
    }
  }, [isAdmin, requestedAssistanceSelector]);

  const vehicleMap = useMemo(() => {
    const map = new Map<string, Vehicle>();
    vehicles?.forEach((v) => map.set(v.id, v));
    return map;
  }, [vehicles]);

  const appliedRouteRequest = useRef<string | null>(null);
  useEffect(() => {
    if (
      requestedRouteId &&
      appliedRouteRequest.current !== requestedRouteId &&
      activeRoutes.some((route) => route.id === requestedRouteId)
    ) {
      setSelectedRouteId(requestedRouteId);
      appliedRouteRequest.current = requestedRouteId;
    }
    if (!requestedRouteId) appliedRouteRequest.current = null;
  }, [activeRoutes, requestedRouteId]);

  const routeVehicle = activeRoute?.vehicleId ? vehicleMap.get(activeRoute.vehicleId) : null;
  const routeChat = useListRouteMessages(activeRoute?.id ?? "", undefined, {
    query: {
      queryKey: ["route-chat-preview", user?.id, activeRoute?.id],
      // Preserve this app's bearer-only and driver-assistance transport.
      queryFn: () => api.getRouteMessages(activeRoute!.id),
      enabled: !!activeRoute?.id && isOnline,
      refetchInterval: isOnline ? 30_000 : false,
      retry: false,
    },
  });
  const latestDispatchMessage = routeChat.data?.messages
    .filter((message) => message.authorId !== user?.id).at(-1);
  const { data: routeIncidents } = useQuery<RouteIncident[]>({
    queryKey: ["route-incidents", activeRoute?.id],
    queryFn: () => api.getRouteIncidents(activeRoute!.id),
    enabled: !!activeRoute?.id,
    refetchInterval: isOnline ? 15000 : false,
    refetchOnWindowFocus: true,
  });

  const handoffMutation = useMutation({
    mutationFn: ({
      route,
      status,
      reason,
    }: {
      route: Route;
      status: "received" | "opened" | "accepted" | "rejected";
      reason?: string;
    }) => api.updateRouteHandoff(route.id, { status, version: route.handoffVersion, reason }),
    onSuccess: (updated, { status }) => {
      handoffUpdatesInFlight.current.delete(updated.id);
      queryClient.setQueryData<Route[]>(["routes", routeScopeKey], (current) =>
        current?.map((route) => route.id === updated.id ? mergeHandoffResponse(route, updated) : route),
      );
      // Automatic receipt/open acknowledgements may finish while the driver
      // is deciding. Only an explicit decision may dismiss that dialog.
      if (status === "accepted" || status === "rejected") {
        setHandoffDialog(null);
        setRejectionReason("");
      }
    },
    onError: (err: any) => {
      handoffUpdatesInFlight.current.clear();
      Alert.alert(t("handoff.updateFailed"), localizeError(err, lang, { fallback: t("routes.updateFailedMsg") }));
    },
  });

  const isHandoffDecisionPending = handoffMutation.isPending
    && (handoffMutation.variables?.status === "accepted" || handoffMutation.variables?.status === "rejected");

  useEffect(() => {
    if (!canOperate) return;
    const sentRoutes = (routes ?? []).filter(
      (route) => route.handoffStatus === "sent" && Number.isFinite(route.handoffVersion),
    );
    sentRoutes.forEach((route) => {
      if (handoffUpdatesInFlight.current.has(route.id)) return;
      handoffUpdatesInFlight.current.add(route.id);
      handoffMutation.mutate({ route, status: "received" });
    });
  }, [canOperate, routes]);

  useEffect(() => {
    if (!canOperate) return;
    if (
      activeRoute?.handoffStatus === "received" &&
      Number.isFinite(activeRoute.handoffVersion) &&
      !handoffUpdatesInFlight.current.has(activeRoute.id)
    ) {
      handoffUpdatesInFlight.current.add(activeRoute.id);
      handoffMutation.mutate({ route: activeRoute, status: "opened" });
    }
  }, [activeRoute?.id, activeRoute?.handoffStatus, activeRoute?.handoffVersion, canOperate]);

  const { data: stops, isLoading: stopsLoading, error: stopsError, refetch: refetchStops } = useQuery({
    queryKey: ["stops", activeRoute?.id],
    queryFn: async () => {
      if (isAssisting) return api.getRouteStops(activeRoute!.id);
      try {
        const result = await api.getRouteStops(activeRoute!.id);
        await setCachedData(`stops_${activeRoute!.id}`, result);
        return result;
      } catch (err) {
        if (isAuthError(err)) throw err;
        const cached = await getCachedData<Stop[]>(`stops_${activeRoute!.id}`);
        if (cached) return cached;
        throw err;
      }
    },
    enabled: !!activeRoute,
    refetchInterval: isOnline ? 15000 : false,
    refetchOnWindowFocus: true,
  });

  const sortedStops = stops
    ? [...stops].sort((a, b) => (a.sequenceOrder ?? 99) - (b.sequenceOrder ?? 99))
    : [];

  // A stop needs attention if it is pending (pickup or delivery) or in_progress (delivery step of P&D)
  const isRouteAccepted = activeRoute?.handoffStatus === "accepted" &&
    activeRoute.handoffVersion === activeRoute.planRevision;
  const { data: assistanceExecution, refetch: refetchAssistanceExecution } = useQuery({
    queryKey: ["route-execution", activeRoute?.id, routeScopeKey],
    queryFn: () => api.getRouteExecution(activeRoute!.id),
    enabled: isAssisting && !!activeRoute?.id,
    refetchInterval: isAssisting && isOnline ? 15_000 : false,
  });
  const assistanceLifecycleMutation = useMutation({
    mutationFn: (action: "start" | "end") => api.executeRouteLifecycle(
      activeRoute!.id,
      action,
      `assistance-${action}-${activeRoute!.id}-${Date.now()}`,
    ),
    onSuccess: () => refetchAssistanceExecution(),
    onError: (error) => Alert.alert(t("routes.updateFailed"), localizeError(error, lang)),
  });
  const gps = useGpsTracking(
    activeRoute?.id,
    activeRoute?.vehicleId,
    !isAdmin && isRouteAccepted,
    gpsOwner,
  );
  const plannedByStopId = useMemo(() => {
    const map: Record<string, string> = {};
    for (const item of activeRoute?.workdayTimeline ?? []) {
      if (item.type === "service" && item.stopId && !map[item.stopId]) map[item.stopId] = item.startAt;
    }
    return map;
  }, [activeRoute?.workdayTimeline]);
  const reportQueue = useOfflineQueueStatus(!isAdmin && !isAssisting && !!driver);
  const pendingReports = reportQueue.items.filter(item => item.queueType === "stopReport" &&
    item.routeId === activeRoute?.id && item.planVersion === activeRoute?.planRevision);
  const activeStop = canOperate && isRouteAccepted
    ? sortedStops.find((s) => (s.status === "pending" || s.status === "in_progress") &&
      !pendingReports.some(item => item.stopId === s.id && item.queueType === "stopReport" &&
        item.stage === "delivery" && item.syncStatus !== "conflict"))
    : undefined;
  // Presentation only: never change the route's canonical sequence or next-stop selection.
  const displayStops = [
    ...sortedStops.filter(stop => stop.id === activeStop?.id),
    ...sortedStops.filter(stop => stop.id !== activeStop?.id && !["completed", "failed", "skipped"].includes(stop.status)),
    ...sortedStops.filter(stop => ["completed", "failed", "skipped"].includes(stop.status)),
  ];

  // Count only fully-resolved stops toward progress
  const completedCount = sortedStops.filter(
    (s) => s.status === "completed" || s.status === "failed" || s.status === "skipped"
  ).length;

  const updateMutation = useMutation<unknown, Error, { id: string; status: string; reason?: string; comment?: string }>({
    mutationFn: ({ id, status, reason, comment }: { id: string; status: string; reason?: string; comment?: string }) =>
      status === "in_progress"
        ? ensureRouteExecutionForWork(activeRoute!.id, activeRoute!.planRevision)
            .then(() => api.updateStop(id, { status } as any))
        : api.createStopExecutionEvent(id, {
            clientEventId: `${id}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
            type: executionEventTypeForStatus(status),
            planVersion: activeRoute?.planRevision ?? activeRoute?.handoffVersion ?? 0,
            occurredAt: new Date().toISOString(),
            skipReason: reason,
            comment,
          }),
    onSuccess: () => {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      queryClient.invalidateQueries({ queryKey: ["stops", activeRoute?.id] });
      queryClient.invalidateQueries({ queryKey: ["routes", routeScopeKey] });
    },
    onError: (err: any) => {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      Alert.alert(t("routes.updateFailed"), localizeError(err, lang, { fallback: t("routes.updateFailedMsg") }));
    },
  });

  const handleStatusUpdate = useCallback(
    async (id: string, status: string) => {
      if (status === "skipped") {
        const target = sortedStops.find((item) => item.id === id);
        // Transport stops use the canonical proof report (photo/signature, offline IDs).
        // Service jobs are rejected by the proof screen, so they keep the reason modal.
        if (target && target.jobType !== "field_service" && activeRoute) {
          router.push({
            pathname: "/proof/[stopId]",
            params: {
              stopId: id, routeId: activeRoute.id,
              planVersion: activeRoute.planRevision ?? activeRoute.handoffVersion ?? 0,
              step: isPdStop(target) && target.status === "pending" ? "pickup" : "delivery",
              outcome: "skipped",
            },
          });
          return;
        }
        setSkipStopId(id);
        setSkipReason(null);
        setSkipComment("");
        return;
      }
      if (!isOnline) {
        if (isAssisting) {
          Alert.alert(t("routes.updateFailed"), "Live assistance requires an online connection. No action was queued.");
          return;
        }
        await enqueueStopStatusUpdate(id, status, activeRoute?.planRevision ?? activeRoute?.handoffVersion ?? 0, { routeId: activeRoute?.id });
        queryClient.setQueryData(["stops", activeRoute?.id], (old: Stop[] | undefined) =>
          old ? old.map((s) => (s.id === id ? { ...s, status } : s)) : old
        );
        if (Platform.OS !== "web") {
          Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
        }
        return;
      }
      updateMutation.mutate({ id, status });
    },
    [updateMutation, isOnline, isAssisting, sortedStops, activeRoute, activeRoute?.id, activeRoute?.planRevision, activeRoute?.handoffVersion, queryClient, lang, t],
  );

  const confirmSkip = useCallback(async () => {
    if (!skipStopId || !skipReason) return;
    const details = { skipReason, comment: skipComment.trim() || undefined };
    if (!isOnline) {
      if (isAssisting) {
        Alert.alert(t("routes.updateFailed"), "Live assistance requires an online connection. No action was queued.");
        return;
      }
      await enqueueStopStatusUpdate(
        skipStopId,
        "skipped",
        activeRoute?.planRevision ?? activeRoute?.handoffVersion ?? 0,
        details,
      );
      queryClient.setQueryData(["stops", activeRoute?.id], (old: Stop[] | undefined) =>
        old?.map((stop) => stop.id === skipStopId ? { ...stop, status: "skipped" } : stop),
      );
    } else {
      updateMutation.mutate({ id: skipStopId, status: "skipped", reason: skipReason, comment: details.comment });
    }
    setSkipStopId(null);
  }, [skipStopId, skipReason, skipComment, isOnline, isAssisting, activeRoute, queryClient, updateMutation, t]);

  const onRefresh = useCallback(() => {
    refetchRoutes();
    if (activeRoute) refetchStops();
  }, [refetchRoutes, refetchStops, activeRoute]);

  useEffect(() => {
    if (requestedReview === "1" && activeRoute) {
      setReviewRequired(true);
    }
  }, [activeRoute?.id, activeRoute?.planRevision, requestedReview]);

  useEffect(() => {
    if (!activeRoute || !canOperate) return;
    if (knownPlanRevision.current === null) {
      knownPlanRevision.current = activeRoute.planRevision;
      return;
    }
    if (knownPlanRevision.current !== activeRoute.planRevision) {
      knownPlanRevision.current = activeRoute.planRevision;
      setReviewRequired(true);
      void refetchStops();
    }
  }, [activeRoute?.id, activeRoute?.planRevision, canOperate, refetchStops]);

  const startTracking = useCallback(async () => {
    try {
      await gps.start();
    } catch (err: any) {
      Alert.alert(t("gps.startFailed"), localizeError(err, lang, { fallback: t("gps.retry") }));
    }
  }, [gps.start]);

  const endTracking = useCallback(async () => {
    if (hasUnresolvedTrackingStops(stops)) {
      Alert.alert(t("gps.endFailed"), localizeError({ code: "routeStopsRemain" }, lang));
      return;
    }
    try {
      const ended = await gps.end();
      if (ended?.summary) {
        setTrackingSummary(ended.summary);
        setShowTrackingSummary(true);
      }
    } catch (err: any) {
      Alert.alert(t("gps.endFailed"), localizeError(err, lang, { fallback: t("gps.retryShort") }));
    }
  }, [gps.end, stops, lang, t]);

  const selectRoute = (routeId: string) => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    setSelectedRouteId(routeId);
    setShowRouteSelector(false);
  };

  const incidentMutation = useMutation({
    mutationFn: () => {
      const attachmentUrl = deviationEvidence.trim();
      return api.createRouteIncident(activeRoute!.id, {
        category: deviationCategory,
        comment: deviationComment.trim(),
        ...(isHttpsUrl(attachmentUrl) ? { attachmentUrl } : {}),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["route-incidents", activeRoute?.id] });
      setShowDeviation(false);
      setDeviationComment("");
      setDeviationEvidence("");
      Alert.alert(t("deviation.sent"), t("deviation.sentMessage"));
    },
    onError: (err: unknown) => Alert.alert(t("deviation.failed"), localizeError(err, lang, { fallback: t("routes.updateFailedMsg") })),
  });

  const isLoading = routesLoading || stopsLoading;

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <Modal
        visible={showAssistanceSelector}
        accessibilityViewIsModal
        transparent
        animationType="slide"
        onRequestClose={() => setShowAssistanceSelector(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: c.surface, maxHeight: "78%" }]}>
            <Text style={[styles.modalTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
              Assist assigned driver
            </Text>
            <Text style={[styles.handoffSubtitle, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
              Select the driver and their current route. Actions are recorded as you, and never use this device&apos;s GPS.
            </Text>
            {!isOnline ? (
              <Text testID="assistance-selector-offline-blocked" style={{ color: c.warning, marginVertical: 20 }}>
                Live assistance requires an internet connection. Nothing will be queued offline.
              </Text>
            ) : assistanceLoading ? (
              <ActivityIndicator color={c.primary} style={{ marginVertical: 24 }} />
            ) : (assistanceAssignments?.length ?? 0) === 0 ? (
              <Text style={{ color: c.textSecondary, marginVertical: 20 }}>No currently assigned routes are available.</Text>
            ) : (
              <View style={{ gap: 8, marginTop: 16 }}>
                {assistanceAssignments!.map(({ driver: candidate, route: candidateRoute }) => {
                  const selected = assistanceSelection?.driver.id === candidate.id
                    && assistanceSelection.routeId === candidateRoute.id;
                  return (
                    <Pressable
                      key={`${candidate.id}:${candidateRoute.id}`}
                      testID={`assist-${candidate.id}-${candidateRoute.id}`}
                       accessibilityRole="button"
                       accessibilityLabel={`Start live assistance for ${candidate.name}, route ${candidateRoute.name}`}
                      onPress={() => {
                        selectAssistance({ driver: candidate, routeId: candidateRoute.id, routeName: candidateRoute.name });
                        setShowAssistanceSelector(false);
                      }}
                      style={[styles.reasonOption, {
                        borderColor: selected ? c.primary : c.border,
                        backgroundColor: selected ? c.primary + "10" : c.background,
                      }]}
                    >
                      <Feather name={selected ? "check-circle" : "user"} size={18} color={selected ? c.primary : c.textSecondary} />
                      <View style={{ flex: 1 }}>
                        <Text style={{ color: c.text, fontFamily: "Inter_600SemiBold" }}>{candidate.name}</Text>
                        <Text style={{ color: c.textSecondary }}>{candidateRoute.name}</Text>
                      </View>
                    </Pressable>
                  );
                })}
              </View>
            )}
            {isAssisting && (
              <Pressable
                testID="end-driver-assistance"
                onPress={() => {
                  clearAssistance();
                  setShowAssistanceSelector(false);
                }}
                style={[styles.handoffButton, { borderColor: c.danger, backgroundColor: c.danger + "10", marginTop: 16 }]}
              >
                <Text style={{ color: c.danger, textAlign: "center", fontFamily: "Inter_600SemiBold" }}>End assistance</Text>
              </Pressable>
            )}
          </View>
        </View>
      </Modal>
      <Modal
        visible={showTrackingSummary}
        transparent
        animationType="slide"
        onRequestClose={() => setShowTrackingSummary(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: c.surface }]}>
            <Text style={[styles.modalTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
                         {t("gps.ended")}
            </Text>
            {trackingSummary && (
              <View style={{ gap: 8 }}>
                <Text style={{ color: c.text }}>{t("gps.samples", { count: trackingSummary.sampleCount })}</Text>
                <Text style={{ color: c.text }}>{t("gps.distance", { distance: trackingSummary.distanceKm.toFixed(1) })}</Text>
                <Text style={{ color: c.text }}>{t("gps.duration", { duration: trackingSummary.durationMin ?? 0 })}</Text>
              </View>
            )}
            <Pressable
              onPress={() => setShowTrackingSummary(false)}
              style={[styles.handoffButton, { backgroundColor: c.primary, borderColor: c.primary }]}
            >
               <Text style={{ color: "#FFF", fontFamily: "Inter_600SemiBold", textAlign: "center" }}>{t("gps.close")}</Text>
            </Pressable>
          </View>
        </View>
      </Modal>
      <Modal visible={!!skipStopId} transparent animationType="fade" onRequestClose={() => setSkipStopId(null)}>
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: c.surface }]}>
            <Text style={[styles.modalTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
              {t("stop.skipTitle")}
            </Text>
            {[
              ["CUSTOMER_UNAVAILABLE", t("stop.skipCustomer")],
              ["ACCESS_BLOCKED", t("stop.skipAccess")],
              ["ADDRESS_NOT_FOUND", t("stop.skipAddress")],
              ["VEHICLE_OR_SAFETY", t("stop.skipVehicle")],
              ["OTHER", t("stop.skipOther")],
            ].map(([value, label]) => (
              <Pressable
                key={value}
                testID={`skip-reason-${value}`}
                onPress={() => setSkipReason(value)}
                style={[styles.reasonOption, { borderColor: skipReason === value ? c.primary : c.border }]}
              >
                <Feather name={skipReason === value ? "check-circle" : "circle"} size={18} color={skipReason === value ? c.primary : c.textSecondary} />
                <Text style={{ color: c.text }}>{label}</Text>
              </Pressable>
            ))}
            <TextInput
              testID="skip-comment"
              value={skipComment}
              onChangeText={setSkipComment}
               placeholder={t("stop.commentOptional")}
              placeholderTextColor={c.textTertiary}
              multiline
              style={[styles.input, { color: c.text, borderColor: c.border }]}
            />
            <View style={styles.modalActions}>
               <Pressable onPress={() => setSkipStopId(null)}><Text style={{ color: c.textSecondary }}>{t("handoff.cancel")}</Text></Pressable>
              <Pressable testID="confirm-skip" disabled={!skipReason} onPress={confirmSkip}>
                 <Text style={{ color: skipReason ? c.warning : c.textTertiary, fontFamily: "Inter_600SemiBold" }}>{t("stop.skip")}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>
      <View
        style={[
          styles.screenHeader,
          {
            paddingTop: insets.top + 8,
            backgroundColor: c.background,
            borderBottomColor: c.border,
          },
        ]}
      >
        <Pressable
          onPress={() => activeRoutes.length > 1 && setShowRouteSelector(true)}
          style={styles.headerLeft}
        >
          <View>
            <Text style={[styles.greeting, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]} numberOfLines={1}>
              {isAssisting
                ? `Assisting ${operatingDriver?.name ?? "driver"}`
                : isAdmin
                ? t("routes.adminGreeting", { name: user?.name?.split(" ")[0] ?? "Admin" })
                : t("routes.greeting", { name: operatingDriver?.name?.split(" ")[0] ?? t("routes.driverFallback") })}
            </Text>
            <View style={styles.routeNameRow}>
              <Text style={[styles.headerTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
                {activeRoute ? (lang === "sv" ? "Din arbetsdag." : "Your working day.") : t("routes.noActiveRouteHeader")}
              </Text>
              {activeRoutes.length > 1 && (
                <Feather name="chevron-down" size={18} color={c.textSecondary} style={{ marginLeft: 4 }} />
              )}
            </View>
            {(activeRoute || routeVehicle) && (
              <View style={styles.vehicleRow}>
                {routeVehicle && <Feather name="truck" size={12} color={c.textSecondary} />}
                <Text
                  style={[styles.vehicleText, { color: c.textSecondary, fontFamily: "Inter_400Regular", flexShrink: 1 }]}
                  numberOfLines={1}
                >
                  {routeIdentityLine(activeRoute?.name, routeVehicle?.name, undefined, operatingDriver?.name)}
                </Text>
                {routeVehicle?.licensePlate && (
                  <Text style={[styles.vehicleText, { color: c.textSecondary, flexShrink: 0 }]}>
                    · {routeVehicle.licensePlate}
                  </Text>
                )}
              </View>
            )}
          </View>
        </Pressable>
        {isAdmin && (
          <Pressable
            testID="select-driver-assistance"
             accessibilityRole="button"
             accessibilityLabel={isAssisting ? "Switch live assistance assignment" : "Select driver for live assistance"}
            onPress={() => setShowAssistanceSelector(true)}
             disabled={!isOnline}
             accessibilityState={{ disabled: !isOnline }}
             style={[styles.progressChip, {
               backgroundColor: isAssisting ? c.warning + "20" : c.primary + "15",
               opacity: isOnline ? 1 : 0.45,
             }]}
          >
            <Feather name={isAssisting ? "user-check" : "users"} size={16} color={isAssisting ? c.warning : c.primary} />
          </Pressable>
        )}
        {activeRoute && (
          <View style={[styles.progressChip, { backgroundColor: c.primary + "15" }]}>
            <Text style={[styles.progressText, { color: c.primary, fontFamily: "Inter_700Bold" }]}>
              {completedCount}/{sortedStops.length}
            </Text>
          </View>
        )}
      </View>

      {activeRoute && (
        <Pressable accessibilityRole="button"
          accessibilityLabel={lang === "sv" ? "Öppna ruttchatten med trafikledningen" : "Open dispatch route chat"}
          onPress={() => router.push({ pathname: "/messages/[routeId]", params: { routeId: activeRoute.id } })}
          style={{ paddingHorizontal: 20, paddingVertical: 10, backgroundColor: c.surface }}>
          <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold" }}>
            {lang === "sv" ? "Chatt med trafikledningen" : "Chat with dispatch"}
          </Text>
          <Text numberOfLines={2} style={{ color: c.textSecondary }}>
            {routeChat.error
              ? (lang === "sv" ? "Meddelanden kunde inte uppdateras just nu." : "Messages could not be refreshed.")
              : latestDispatchMessage
                ? `${latestDispatchMessage.authorName}: ${latestDispatchMessage.body}`
                : (lang === "sv" ? "Öppna hela ruttens konversation" : "Open the route conversation")}
          </Text>
        </Pressable>
      )}
      {(routesError || stopsError) && activeRoute && stops && !isAuthError(routesError) && !isAuthError(stopsError) && (
        <Text accessibilityRole="alert" style={{ color: c.warning, paddingHorizontal: 20, paddingVertical: 8 }}>
          {lang === "sv"
            ? "Uppdateringen är tillfälligt fördröjd. Senast hämtade uppdrag visas."
            : "Updates are temporarily delayed. Showing the last loaded assignments."}
        </Text>
      )}
      {(routesError || stopsError) && (!activeRoute || !stops || isAuthError(routesError) || isAuthError(stopsError)) ? (
        <View style={styles.centered}>
          <Feather name="alert-circle" size={32} color={c.warning} />
          <Text accessibilityRole="alert" style={[styles.emptySubtitle, { color: c.text }]}>
            {localizeError(routesError ?? stopsError, lang, { fallback: lang === "sv" ? "Rutten kunde inte hämtas. Försök igen." : "Could not load the route. Please try again." })}
          </Text>
          <Pressable accessibilityRole="button" onPress={() => { void refetchRoutes(); void refetchStops(); }} style={[styles.handoffButton, { flex: 0, backgroundColor: c.primary }]}>
            <Text style={{ color: c.surface, fontFamily: "Inter_600SemiBold" }}>{lang === "sv" ? "Försök igen" : "Try again"}</Text>
          </Pressable>
        </View>
      ) : isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      ) : !activeRoute ? (
        <View style={styles.centered}>
          <Feather name="inbox" size={48} color={c.textTertiary} />
          <Text style={[styles.emptyTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
            {t("routes.noActiveRouteTitle")}
          </Text>
          <Text style={[styles.emptySubtitle, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
            {t("routes.noActiveRouteSubtitle")}
          </Text>
          <Pressable testID="empty-routes-explore" onPress={() => router.push("/explore")} style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12 }}>
          <Feather name="compass" size={16} color={c.primary} />
          <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>Utforska appen utan uppdrag</Text>
        </Pressable>
        </View>
      ) : (
        <FlatList
          data={displayStops}
          keyExtractor={(item) => item.id}
          scrollEnabled={sortedStops.length > 0}
          contentContainerStyle={[
            styles.listContent,
            { paddingBottom: tabBarHeight + 16 },
          ]}
          refreshControl={
            <RefreshControl
              refreshing={false}
              onRefresh={onRefresh}
              tintColor={c.primary}
            />
          }
          ListHeaderComponent={
            <View style={styles.handoffArea}>
              <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: sortedStops.length, now: completedCount }}
                style={{ height: 5, backgroundColor: c.border, borderRadius: 5, overflow: "hidden", marginBottom: 10 }}>
                <View style={{ height: 5, width: `${sortedStops.length ? (completedCount / sortedStops.length) * 100 : 0}%`, backgroundColor: c.primary }} />
              </View>
              {!isAdmin && <SyncSummary online={isOnline} pending={reportQueue.pending.length}
                conflicts={reportQueue.conflicts.length} legacy={reportQueue.legacyPendingCount}
                error={reportQueue.error} loaded={reportQueue.loaded} />}
              {!isAdmin && activeRoute && isRouteAccepted && (
                <View style={[styles.trackingCard, { backgroundColor: c.surface, borderColor: gps.error ? c.danger + "60" : c.border }]}>
                  <View style={styles.handoffTitleRow}>
                    <Feather name={gps.session ? "radio" : "map-pin"} size={20} color={gps.error ? c.danger : c.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.handoffTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
                         {gps.error ? (lang === "sv" ? "GPS behöver åtgärdas" : "GPS needs attention")
                           : gps.session && !gps.lastPosition ? (lang === "sv" ? "GPS söker position…" : "GPS locating…")
                           : gps.session ? t("gps.active") : t("gps.inactive")}
                      </Text>
                      <Text style={[styles.handoffSubtitle, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                        {gps.lastPosition
                           ? t("gps.lastPosition", {
                               time: new Date(gps.lastPosition.recordedAt).toLocaleTimeString(),
                               accuracy: Math.round(gps.lastPosition.accuracy ?? 0),
                             })
                           : t("gps.startHint")}
                      </Text>
                    </View>
                    <Pressable
                      accessibilityRole="button"
                      onPress={gps.session ? endTracking : startTracking}
                      disabled={gps.isStarting || gps.isEnding}
                      style={[styles.trackingButton, { backgroundColor: gps.session ? c.danger : c.primary, opacity: gps.isStarting || gps.isEnding ? 0.5 : 1 }]}
                    >
                      <Text style={{ color: "#FFF", fontFamily: "Inter_600SemiBold", fontSize: 12 }}>
                         {gps.session ? t("service.completeWork") : t("service.startWork")}
                      </Text>
                    </Pressable>
                  </View>
                  {gps.error && (
                    <Text style={[styles.gpsError, { color: c.danger, fontFamily: "Inter_500Medium" }]}>
                      {gps.error}
                    </Text>
                  )}
                  {gps.error && gps.session && <Pressable accessibilityRole="button"
                    disabled={gps.isStarting || gps.isEnding} onPress={startTracking}
                    style={{ minHeight: 44, justifyContent: "center" }}>
                    <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold" }}>
                      {lang === "sv" ? "Försök starta GPS igen" : "Retry GPS"}
                    </Text>
                  </Pressable>}
                  {Platform.OS === "web" && <Text style={{ color: c.textSecondary, fontSize: 12 }}>
                    {lang === "sv" ? "Tillåt platsåtkomst. Ha appen öppen under körning – webbläsaren kan pausa GPS när skärmen låses."
                      : "Allow location access. Keep the app open while driving – the browser may pause GPS when the screen locks."}
                  </Text>}
                </View>
              )}
              {isAssisting && activeRoute && isRouteAccepted && (
                <View style={[styles.trackingCard, { backgroundColor: c.surface, borderColor: c.border }]}>
                  <View style={styles.handoffTitleRow}>
                    <Feather name="play-circle" size={20} color={c.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.handoffTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
                        {assistanceExecution?.status === "active" ? "Route execution active" : "Route execution not started"}
                      </Text>
                      <Text style={[styles.handoffSubtitle, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                         {isOnline
                           ? "Live assistance controls route execution only. Driver GPS remains disabled on this device."
                           : "Route execution is blocked offline and will not be queued. Driver GPS remains disabled on this device."}
                      </Text>
                       {!isOnline && (
                         <Text testID="assistance-route-lifecycle-offline-blocked" style={{ color: c.warning, fontSize: 12 }}>
                           Connect to continue live assistance.
                         </Text>
                       )}
                    </View>
                    <Pressable
                      testID="assistance-route-lifecycle"
                      accessibilityRole="button"
                     accessibilityLabel={assistanceExecution?.status === "active" ? "End assisted route execution" : "Start assisted route execution"}
                      onPress={() => assistanceLifecycleMutation.mutate(
                        assistanceExecution?.status === "active" ? "end" : "start",
                      )}
                     disabled={assistanceLifecycleMutation.isPending || !isOnline}
                     accessibilityState={{ disabled: assistanceLifecycleMutation.isPending || !isOnline }}
                      style={[styles.trackingButton, {
                        backgroundColor: assistanceExecution?.status === "active" ? c.danger : c.primary,
                       opacity: assistanceLifecycleMutation.isPending || !isOnline ? 0.5 : 1,
                      }]}
                    >
                      <Text style={{ color: "#FFF", fontFamily: "Inter_600SemiBold", fontSize: 12 }}>
                        {assistanceExecution?.status === "active" ? t("service.completeWork") : t("service.startWork")}
                      </Text>
                    </Pressable>
                  </View>
                </View>
              )}
              {canOperate && reviewRequired && activeRoute && (
                <View style={[styles.planReviewCard, { backgroundColor: c.warning + "15", borderColor: c.warning + "60" }]}>
                  <Feather name="refresh-cw" size={18} color={c.warning} />
                  <View style={{ flex: 1 }}>
                     <Text style={{ color: c.text, fontFamily: "Inter_700Bold" }}>{t("gps.changed")}</Text>
                    <Text style={{ color: c.textSecondary, fontFamily: "Inter_400Regular" }}>
                       {t("gps.review", { version: activeRoute.planRevision })}
                    </Text>
                  </View>
                  <Pressable onPress={() => { setReviewRequired(false); refetchRoutes(); refetchStops(); }}>
                     <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold" }}>{t("gps.refresh")}</Text>
                  </Pressable>
                </View>
              )}
              {!canOperate ? (
                <View style={[styles.handoffCard, { backgroundColor: c.primary + "10", borderColor: c.primary + "40" }]}>
                  <View style={styles.handoffTitleRow}>
                    <Feather name="shield" size={20} color={c.primary} />
                    <View style={{ flex: 1 }}>
                      <Text style={[styles.handoffTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
                        {t("routes.adminOverviewTitle")}
                      </Text>
                      <Text style={[styles.handoffSubtitle, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                        {t("routes.adminOverviewDescription")}
                      </Text>
                    </View>
                  </View>
                </View>
              ) : isRouteAccepted ? (
                <Text style={{ fontSize: 13, color: c.primary, fontFamily: "Inter_600SemiBold" }}>
                  {t("handoff.status.accepted")} · {t("handoff.version", { version: activeRoute.handoffVersion })}
                </Text>
              ) : (
                <View style={[styles.handoffCard, { backgroundColor: isRouteAccepted ? c.success + "12" : c.surface, borderColor: isRouteAccepted ? c.success + "50" : c.border }]}>
                <View style={styles.handoffTitleRow}>
                  <Feather
                    name={isRouteAccepted ? "check-circle" : activeRoute.handoffStatus === "rejected" ? "x-circle" : "clipboard"}
                    size={20}
                    color={isRouteAccepted ? c.success : activeRoute.handoffStatus === "rejected" ? c.danger : c.primary}
                  />
                  <View style={{ flex: 1 }}>
                    <Text style={[styles.handoffTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
                      {t(`handoff.status.${activeRoute.handoffStatus}`)}
                    </Text>
                    <Text style={[styles.handoffSubtitle, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                      {t("handoff.version", { version: activeRoute.handoffVersion })}
                    </Text>
                  </View>
                </View>
                {activeRoute.handoffStatus === "rejected" && activeRoute.rejectionReason ? (
                  <Text style={[styles.rejectionText, { color: c.danger, fontFamily: "Inter_500Medium" }]}>
                    {activeRoute.rejectionReason}
                  </Text>
                ) : null}
                {(activeRoute.handoffStatus === "opened" || activeRoute.handoffStatus === "received") && (
                  <>
                    <Text style={[styles.acceptPrompt, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                      {t("handoff.acceptPrompt")}
                    </Text>
                    <View style={styles.handoffActions}>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setHandoffDialog("reject")}
                        style={[styles.handoffButton, { borderColor: c.danger, backgroundColor: c.danger + "10" }]}
                      >
                        <Text style={{ color: c.danger, fontFamily: "Inter_600SemiBold" }}>{t("handoff.reject")}</Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        onPress={() => setHandoffDialog("accept")}
                        style={[styles.handoffButton, { borderColor: c.success, backgroundColor: c.success }]}
                      >
                        <Text style={{ color: "#FFF", fontFamily: "Inter_600SemiBold" }}>{t("handoff.accept")}</Text>
                      </Pressable>
                    </View>
                  </>
                )}
                {!isRouteAccepted && activeRoute.handoffStatus !== "rejected" && (
                  <Text style={[styles.lockedText, { color: c.warning, fontFamily: "Inter_600SemiBold" }]}>
                    {t("handoff.actionsLocked")}
                  </Text>
                )}
                </View>
              )}
              <Disclosure title={lang === "sv" ? "Trafikledning och avvikelser" : "Dispatch and incidents"}>
              {canOperate && isRouteAccepted && (
                <View style={{ gap: 8 }}>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t("deviation.report")}
                    onPress={() => setShowDeviation(true)}
                    style={[styles.deviationButton, { backgroundColor: c.warning + "12", borderColor: c.warning + "50" }]}
                  >
                    <Feather name="alert-triangle" size={18} color={c.warning} />
                    <Text style={{ color: c.text, fontFamily: "Inter_600SemiBold" }}>{t("deviation.report")}</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    onPress={() => router.push({ pathname: "/messages/[routeId]", params: { routeId: activeRoute.id } })}
                    style={[styles.deviationButton, { backgroundColor: c.info + "12", borderColor: c.info + "50" }]}
                  >
                    <Feather name="message-circle" size={18} color={c.info} />
                    <Text style={{ color: c.text, fontFamily: "Inter_600SemiBold" }}>{t("messages.title")}</Text>
                  </Pressable>
                </View>
              )}
              {(routeIncidents?.length ?? 0) > 0 && (
                <View
                  style={[styles.incidentHistory, { borderTopColor: c.border }]}
                  accessibilityLabel={t("deviation.history")}
                >
                  <Text style={[styles.incidentHistoryTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
                    {t("deviation.history")}
                  </Text>
                  {routeIncidents!.map((incident) => (
                    <View key={incident.id} style={[styles.incidentItem, { backgroundColor: c.background, borderColor: c.border }]}>
                      <View style={styles.incidentItemHeader}>
                        <Text style={[styles.incidentCategory, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>
                          {t(`deviation.categories.${incident.category}`)}
                        </Text>
                        <Text style={[styles.incidentTime, { color: c.textTertiary, fontFamily: "Inter_400Regular" }]}>
                          {new Date(incident.createdAt).toLocaleString()}
                        </Text>
                      </View>
                      <Text style={[styles.incidentComment, { color: c.text, fontFamily: "Inter_400Regular" }]}>
                        {incident.comment}
                      </Text>
                      {isHttpsUrl(incident.attachmentUrl) ? (
                        <Pressable
                          accessibilityRole="link"
                          accessibilityLabel={t("deviation.openEvidence")}
                          onPress={() => Linking.openURL(incident.attachmentUrl!).catch(() =>
                            Alert.alert(t("deviation.evidenceUnavailable")),
                          )}
                          style={styles.evidenceLink}
                        >
                          <Feather name="external-link" size={13} color={c.primary} />
                          <Text style={[styles.evidenceLinkText, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>
                            {t("deviation.openEvidence")}
                          </Text>
                        </Pressable>
                      ) : incident.attachmentUrl ? (
                        <Text style={[styles.incidentTime, { color: c.textTertiary, fontFamily: "Inter_400Regular" }]}>
                          {incident.attachmentUrl}
                        </Text>
                      ) : null}
                    </View>
                  ))}
                </View>
              )}
              </Disclosure>
            </View>
          }
          ListFooterComponent={activeRoute ? (
            <Disclosure title={lang === "sv" ? "Rutt och dagens tider" : "Route and today's schedule"}>
              <RoutePlanningCard route={activeRoute} />
              <WorkdayTimelineCard route={activeRoute} />
            </Disclosure>
          ) : undefined}
          renderItem={({ item }) => (
            <View>
            {canOperate && isRouteAccepted && item.status === "pending" && item.id !== activeStop?.id && (
              <TakeStopNow key={`${activeRoute?.id}:${activeRoute?.handoffVersion}:${item.id}`} stop={item} />
            )}
            {pendingReports.filter(report => report.stopId === item.id).map(report => (
              <View key={report.id} testID={`stop-sync-${item.id}`} style={{ padding: 12, backgroundColor: "#FFF5D6", borderRadius: 10, marginBottom: 8 }}>
                <Text style={{ color: "#594515", fontFamily: "Inter_600SemiBold" }}>
                  {report.syncStatus === "synced" ? "Synkat med trafikledningen" :
                    report.syncStatus === "conflict" ? "Behöver åtgärdas – rapporten kunde inte godkännas" :
                      report.syncStatus === "syncing" ? "Synkar rapport och bilagor…" : "Sparat på enheten – väntar på synkning"}
                </Text>
              </View>
            ))}
            {isServiceStop(item) ? (
              <ServiceStopCard
                stop={item}
                isActive={canOperate && item.id === activeStop?.id}
                onStatusUpdate={handleStatusUpdate}
                isUpdating={updateMutation.isPending}
                planVersion={activeRoute?.planRevision ?? 0}
                routeId={activeRoute?.id}
                plannedAt={plannedByStopId[item.id] ?? null}
              />
            ) : isPdStop(item) ? (
              <PdStopCard
                stop={item}
                isActive={canOperate && item.id === activeStop?.id}
                onStatusUpdate={handleStatusUpdate}
                isUpdating={updateMutation.isPending}
                planVersion={activeRoute?.planRevision ?? 0}
                routeId={activeRoute?.id}
                plannedAt={plannedByStopId[item.id] ?? null}
              />
            ) : (
              <StopCard
                stop={item}
                isActive={canOperate && item.id === activeStop?.id}
                onStatusUpdate={handleStatusUpdate}
                isUpdating={updateMutation.isPending}
                planVersion={activeRoute?.planRevision ?? 0}
                routeId={activeRoute?.id}
                plannedAt={plannedByStopId[item.id] ?? null}
              />
            )}
            </View>
          )}
        />
      )}

      <Modal
        visible={handoffDialog !== null}
        transparent
        animationType="slide"
        onRequestClose={() => setHandoffDialog(null)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: c.surface }]}>
            <Text style={[styles.modalTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
              {handoffDialog === "accept" ? t("handoff.confirmAccept") : t("handoff.rejectTitle")}
            </Text>
            {handoffDialog === "reject" && (
              <TextInput
                value={rejectionReason}
                onChangeText={setRejectionReason}
                placeholder={t("handoff.reasonPlaceholder")}
                placeholderTextColor={c.textTertiary}
                multiline
                accessibilityLabel={t("handoff.reason")}
                style={[styles.formInput, { color: c.text, borderColor: c.border, backgroundColor: c.background }]}
              />
            )}
            <View style={styles.handoffActions}>
              <Pressable onPress={() => setHandoffDialog(null)} style={[styles.handoffButton, { borderColor: c.border }]}>
                <Text style={{ color: c.text }}>{t("handoff.cancel")}</Text>
              </Pressable>
              <Pressable
                disabled={isHandoffDecisionPending || (handoffDialog === "reject" && !rejectionReason.trim())}
                onPress={() => activeRoute && handoffMutation.mutate({
                  route: activeRoute,
                  status: handoffDialog === "accept" ? "accepted" : "rejected",
                  ...(handoffDialog === "reject" ? { reason: rejectionReason.trim() } : {}),
                })}
                style={[styles.handoffButton, { backgroundColor: handoffDialog === "accept" ? c.success : c.danger, borderColor: "transparent", opacity: isHandoffDecisionPending || (handoffDialog === "reject" && !rejectionReason.trim()) ? 0.5 : 1 }]}
              >
                <Text style={{ color: "#FFF", fontFamily: "Inter_600SemiBold" }}>{t("handoff.confirm")}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showDeviation}
        transparent
        animationType="slide"
        onRequestClose={() => setShowDeviation(false)}
      >
        <View style={styles.modalOverlay}>
          <View style={[styles.modalSheet, { backgroundColor: c.surface }]}>
            <Text style={[styles.modalTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>{t("deviation.title")}</Text>
            <Text style={[styles.formLabel, { color: c.textSecondary }]}>{t("deviation.category")}</Text>
            <View style={styles.categoryRow}>
              {INCIDENT_CATEGORIES.map((category) => (
                <Pressable
                  key={category}
                  accessibilityRole="radio"
                  accessibilityState={{ selected: deviationCategory === category }}
                  onPress={() => setDeviationCategory(category)}
                  style={[styles.categoryChip, { borderColor: deviationCategory === category ? c.primary : c.border, backgroundColor: deviationCategory === category ? c.primary + "15" : c.background }]}
                >
                  <Text style={{ color: deviationCategory === category ? c.primary : c.text, fontSize: 12 }}>{t(`deviation.categories.${category}`)}</Text>
                </Pressable>
              ))}
            </View>
            <TextInput
              value={deviationComment}
              onChangeText={setDeviationComment}
              placeholder={t("deviation.commentPlaceholder")}
              placeholderTextColor={c.textTertiary}
              multiline
              accessibilityLabel={t("deviation.comment")}
              style={[styles.formInput, { color: c.text, borderColor: c.border, backgroundColor: c.background }]}
            />
            <TextInput
              value={deviationEvidence}
              onChangeText={setDeviationEvidence}
              placeholder={t("deviation.evidencePlaceholder")}
              placeholderTextColor={c.textTertiary}
              autoCapitalize="none"
              accessibilityLabel={t("deviation.evidence")}
              style={[styles.formInput, styles.singleLineInput, { color: c.text, borderColor: c.border, backgroundColor: c.background }]}
            />
            <View style={styles.handoffActions}>
              <Pressable onPress={() => setShowDeviation(false)} style={[styles.handoffButton, { borderColor: c.border }]}>
                <Text style={{ color: c.text }}>{t("handoff.cancel")}</Text>
              </Pressable>
              <Pressable
                disabled={!deviationComment.trim() || incidentMutation.isPending}
                onPress={() => incidentMutation.mutate()}
                style={[styles.handoffButton, { backgroundColor: c.primary, borderColor: c.primary, opacity: !deviationComment.trim() || incidentMutation.isPending ? 0.5 : 1 }]}
              >
                <Text style={{ color: "#FFF", fontFamily: "Inter_600SemiBold" }}>{t("deviation.submit")}</Text>
              </Pressable>
            </View>
          </View>
        </View>
      </Modal>

      <Modal
        visible={showRouteSelector}
        transparent
        animationType="slide"
        onRequestClose={() => setShowRouteSelector(false)}
      >
        <Pressable
          style={styles.modalOverlay}
          onPress={() => setShowRouteSelector(false)}
        >
          <View
            style={[
              styles.modalSheet,
              {
                backgroundColor: c.surface,
                paddingBottom: insets.bottom + 16,
              },
            ]}
          >
            <View style={styles.modalHandle} />
            <Text style={[styles.modalTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
              {t("routes.selectRoute")}
            </Text>
            {activeRoutes.map((route) => {
              const vehicle = route.vehicleId ? vehicleMap.get(route.vehicleId) : null;
              const isSelected = route.id === activeRoute?.id;
              return (
                <Pressable
                  key={route.id}
                  onPress={() => selectRoute(route.id)}
                  style={({ pressed }) => [
                    styles.routeOption,
                    {
                      backgroundColor: isSelected ? c.primary + "10" : "transparent",
                      borderColor: isSelected ? c.primary + "40" : c.border,
                      opacity: pressed ? 0.85 : 1,
                    },
                  ]}
                >
                  <View style={[styles.routeOptionIcon, { backgroundColor: c.primary + "15" }]}>
                    <Feather name="map" size={20} color={c.primary} />
                  </View>
                  <View style={styles.routeOptionInfo}>
                    <Text style={[styles.routeOptionName, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
                      {route.name}
                    </Text>
                    {vehicle && (
                      <Text style={[styles.routeOptionVehicle, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                        {vehicle.name}{vehicle.licensePlate ? ` \u2022 ${vehicle.licensePlate}` : ""}
                      </Text>
                    )}
                  </View>
                  {isSelected && (
                    <Feather name="check-circle" size={20} color={c.primary} />
                  )}
                </Pressable>
              );
            })}
          </View>
        </Pressable>
      </Modal>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  screenHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    alignItems: "flex-end",
    paddingHorizontal: 20,
    paddingBottom: 10,
    borderBottomWidth: 1,
    gap: 8,
  },
  headerLeft: { flex: 1 },
  greeting: { fontSize: 13, marginBottom: 0 },
  routeNameRow: { flexDirection: "row", alignItems: "center" },
  headerTitle: { fontSize: 22, letterSpacing: -0.5 },
  vehicleRow: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  vehicleText: { fontSize: 13 },
  versionText: { fontSize: 12, marginTop: 4 },
  progressChip: {
    paddingHorizontal: 12,
    minHeight: 44,
    minWidth: 44,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: 20,
  },
  progressText: { fontSize: 16 },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 40,
  },
  emptyTitle: { fontSize: 20, marginTop: 8 },
  emptySubtitle: { fontSize: 15, textAlign: "center" },
  listContent: { paddingHorizontal: 12, paddingTop: 10, gap: 10 },
  handoffArea: { gap: 10, marginBottom: 12 },
  handoffCard: { borderWidth: 1, borderRadius: 14, padding: 14, gap: 10 },
  handoffTitleRow: { flexDirection: "row", alignItems: "center", gap: 10 },
  handoffTitle: { fontSize: 16 },
  handoffSubtitle: { fontSize: 12, marginTop: 2 },
  rejectionText: { fontSize: 13 },
  acceptPrompt: { fontSize: 13, lineHeight: 18 },
  lockedText: { fontSize: 12 },
  handoffActions: { flexDirection: "row", gap: 10 },
  handoffButton: { flex: 1, minHeight: 44, alignItems: "center", justifyContent: "center", borderRadius: 10, borderWidth: 1, paddingHorizontal: 12 },
  deviationButton: { minHeight: 48, borderWidth: 1, borderRadius: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8 },
  incidentHistory: { borderTopWidth: 1, paddingTop: 12, gap: 8 },
  incidentHistoryTitle: { fontSize: 14 },
  incidentItem: { borderWidth: 1, borderRadius: 10, padding: 10, gap: 5 },
  incidentItemHeader: { flexDirection: "row", justifyContent: "space-between", gap: 8 },
  incidentCategory: { fontSize: 12, flex: 1 },
  incidentTime: { fontSize: 10, textAlign: "right" },
  incidentComment: { fontSize: 13, lineHeight: 18 },
  evidenceLink: { alignSelf: "flex-start", minHeight: 30, flexDirection: "row", alignItems: "center", gap: 5 },
  evidenceLinkText: { fontSize: 12, textDecorationLine: "underline" },

  stopCard: {
    borderRadius: 14,
    padding: 14,
    gap: 12,
  },
  stopHeader: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 12,
  },
  sequenceBadge: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: "center",
    justifyContent: "center",
  },
  sequenceText: { fontSize: 15 },
  stopInfo: { flex: 1, gap: 4 },
  stopAddress: { fontSize: 15, lineHeight: 20 },
  stopMeta: { flexDirection: "row", gap: 12, marginTop: 2 },
  metaChip: { flexDirection: "row", alignItems: "center", gap: 4 },
  metaText: { fontSize: 12 },
  contactText: { fontSize: 13, marginTop: 2 },
  statusBadge: {
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: "center",
    justifyContent: "center",
  },
  actionRow: {
    flexDirection: "row",
    gap: 8,
    paddingTop: 4,
  },
  actionBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 6,
    paddingVertical: 10,
    paddingHorizontal: 14,
    borderRadius: 10,
    borderWidth: 1,
    borderColor: "transparent",
  },
  actionBtnWide: { flex: 1 },
  actionLabel: { fontSize: 14 },
  // P&D-specific styles
  pdLabelRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    flexWrap: "wrap",
  },
  pdBadge: {
    paddingHorizontal: 6,
    paddingVertical: 2,
    borderRadius: 6,
  },
  pdBadgeText: { fontSize: 11 },
  stepRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: 10,
    padding: 10,
    borderRadius: 10,
    borderWidth: 1,
  },
  stepIconWrap: {
    width: 30,
    height: 30,
    borderRadius: 15,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  stepInfo: { flex: 1, gap: 2 },
  stepLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 0.5 },
  stepAddress: { fontSize: 14, lineHeight: 19 },
  stepDoneChip: {
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    paddingHorizontal: 8,
    paddingVertical: 4,
    borderRadius: 8,
    alignSelf: "flex-start",
    flexShrink: 0,
  },
  stepDoneText: { fontSize: 11 },
  stepConnector: {
    alignItems: "center",
    marginVertical: -4,
    marginLeft: 24,
  },
  stepConnectorLine: {
    width: 2,
    height: 14,
    borderRadius: 1,
  },
  // Modal
  modalOverlay: {
    flex: 1,
    backgroundColor: "rgba(0,0,0,0.4)",
    justifyContent: "flex-end",
  },
  modalSheet: {
    borderTopLeftRadius: 20,
    borderTopRightRadius: 20,
    padding: 20,
    gap: 12,
  },
  reasonOption: { flexDirection: "row", alignItems: "center", gap: 10, padding: 12, borderWidth: 1, borderRadius: 10 },
  input: { minHeight: 72, borderWidth: 1, borderRadius: 10, padding: 12, textAlignVertical: "top" },
  modalActions: { flexDirection: "row", alignItems: "center", justifyContent: "flex-end", gap: 24, paddingVertical: 8 },
  formLabel: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  formInput: { minHeight: 96, borderWidth: 1, borderRadius: 10, padding: 12, fontSize: 15, textAlignVertical: "top" },
  singleLineInput: { minHeight: 46, textAlignVertical: "center" },
  categoryRow: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  categoryChip: { minHeight: 36, justifyContent: "center", paddingHorizontal: 12, borderWidth: 1, borderRadius: 18 },
  modalHandle: {
    width: 40,
    height: 4,
    borderRadius: 2,
    backgroundColor: "#CCC",
    alignSelf: "center",
    marginBottom: 8,
  },
  modalTitle: { fontSize: 20, marginBottom: 4 },
  routeOption: {
    flexDirection: "row",
    alignItems: "center",
    padding: 14,
    borderRadius: 12,
    borderWidth: 1,
    gap: 12,
  },
  routeOptionIcon: {
    width: 40,
    height: 40,
    borderRadius: 20,
    alignItems: "center",
    justifyContent: "center",
  },
  routeOptionInfo: { flex: 1, gap: 2 },
  routeOptionName: { fontSize: 16 },
  routeOptionVehicle: { fontSize: 13 },
  timelineCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    gap: 16,
    marginBottom: 8,
  },
  routeInstructions: {
    borderWidth: 1,
    borderRadius: 10,
    padding: 10,
    gap: 5,
  },
  routeInstructionsText: {
    fontSize: 14,
    lineHeight: 20,
  },
  trackingCard: {
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
    gap: 8,
  },
  trackingButton: {
    minWidth: 64,
    paddingHorizontal: 10,
    paddingVertical: 8,
    borderRadius: 8,
    alignItems: "center",
  },
  gpsError: {
    fontSize: 13,
    lineHeight: 18,
  },
  planReviewCard: {
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderWidth: 1,
    borderRadius: 14,
    padding: 14,
    marginBottom: 8,
  },
  timelineHeaderTitle: {
    fontSize: 16,
  },
  summaryGrid: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: 8,
  },
  summaryStat: {
    paddingVertical: 8,
    paddingHorizontal: 12,
    borderWidth: 1,
    borderRadius: 8,
    minWidth: "30%",
    flexGrow: 1,
  },
  summaryStatLabel: {
    fontSize: 11,
    textTransform: "uppercase",
    letterSpacing: 0.5,
    marginBottom: 2,
  },
  summaryStatValue: {
    fontSize: 18,
  },
  timelineList: {
    gap: 0,
    marginTop: 4,
  },
  timelineRow: {
    flexDirection: "row",
    minHeight: 48,
  },
  timelineTimeCol: {
    width: 65,
    alignItems: "flex-end",
    paddingRight: 10,
    paddingTop: 2,
  },
  timelineTime: {
    fontSize: 14,
  },
  timelineDuration: {
    fontSize: 11,
    marginTop: 2,
  },
  timelineTrack: {
    width: 24,
    alignItems: "center",
  },
  timelineTrackLine: {
    width: 2,
    flex: 1,
  },
  timelineDot: {
    width: 24,
    height: 24,
    borderRadius: 12,
    alignItems: "center",
    justifyContent: "center",
    marginVertical: 4,
  },
  timelineContent: {
    flex: 1,
    paddingLeft: 12,
    paddingTop: 4,
    paddingBottom: 16,
  },
  timelineItemLabel: {
    fontSize: 15,
  },
  timelineItemSub: {
    fontSize: 13,
    marginTop: 2,
  },
});
