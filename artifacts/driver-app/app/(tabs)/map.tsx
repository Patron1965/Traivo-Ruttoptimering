import React, { useMemo, useState, useEffect, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  Platform,
  Linking,
  Alert,
  ScrollView,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useTabBarHeight } from "@/hooks/useTabBarHeight";
import Colors from "@/constants/colors";
import { useSelectedRoute } from "@/context/SelectedRouteContext";
import {
  api,
  isAuthError,
  type Stop,
  type RouteGeometryResult,
  fetchRouteGeometry,
  isValidRouteCoordinate,
} from "@/lib/api";
import NativeMap from "@/components/NativeMap";
import { TakeStopNow } from "@/components/TakeStopNow";
import { useT } from "@/lib/i18n";
import {
  availableNavigationApps,
  buildNavigationUrl,
  getVerifiedNavigationDestination,
  navigationAppLabel,
  type NavigationApp,
} from "@/lib/external-navigation";
import { getNextPendingStop } from "@/lib/next-stop";
import { getCachedData, setCachedData } from "@/lib/offline-queue";
import { localizeError } from "@/lib/error-localizer";

const STATUS_COLORS: Record<string, string> = {
  pending: Colors.light.primary,
  completed: Colors.light.success,
  failed: Colors.light.danger,
  skipped: Colors.light.warning,
};

export default function MapTab() {
  const c = Colors.light;
  const { activeRoute, routeScopeKey } = useSelectedRoute();
  const { t, lang } = useT();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useTabBarHeight();
  const [geometryResult, setGeometryResult] = useState<{ key: string; geometry: RouteGeometryResult } | null>(null);
  const [preview, setPreview] = useState<{ scope: string; stopId: string } | null>(null);
  const previewScope = `${routeScopeKey}:${activeRoute?.id}:${activeRoute?.handoffVersion}`;
  const setPreviewStop = useCallback((stopId: string) => setPreview({ scope: previewScope, stopId }), [previewScope]);
  const [viewportCommand, setViewportCommand] = useState<{ type: "in" | "out" | "fit"; revision: number }>();
  const command = (type: "in" | "out" | "fit") => setViewportCommand(previous => ({ type, revision: (previous?.revision ?? 0) + 1 }));

  const { data: stops, isLoading, error } = useQuery({
    queryKey: ["stops", activeRoute?.id],
    queryFn: async () => {
      try {
        const result = await api.getRouteStops(activeRoute!.id);
        await setCachedData(`stops_${activeRoute!.id}`, result);
        return result;
      } catch (error) {
        if (isAuthError(error)) throw error;
        const cached = await getCachedData<Stop[]>(`stops_${activeRoute!.id}`);
        if (cached) return cached;
        throw error;
      }
    },
    enabled: !!activeRoute,
    refetchInterval: 15000,
  });

  const validStops = useMemo(
    () => (stops ?? [])
      .filter((s) => isValidRouteCoordinate(s.latitude, s.longitude))
      .sort((a, b) => (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER) - (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER)),
    [stops],
  );

  const nextStop = useMemo(() => (stops ?? []).find(stop =>
    stop.id === activeRoute?.executionProjection?.activeStopId && stop.status === "pending")
    ?? getNextPendingStop(stops ?? []), [stops, activeRoute?.executionProjection?.activeStopId]);
  const orderedStops = useMemo(() => [...(stops ?? [])].sort((a, b) =>
    (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER) - (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER)), [stops]);
  const previewStop = preview?.scope === previewScope
    ? orderedStops.find(stop => stop.id === preview?.stopId) : undefined;
  const completedCount = orderedStops.filter(stop => stop.status === "completed").length;
  const nextLeg = activeRoute?.executionProjection?.selectionChangedAt ? undefined : activeRoute?.workdayTimeline?.filter(event =>
    event.type === "driving" && event.stopId === nextStop?.id);
  const plannedTravelMin = nextLeg?.length ? nextLeg.reduce((sum, event) => sum + event.durationMin, 0) : null;
  const plannedDistanceKm = nextLeg?.length && nextLeg.every(event => Number.isFinite(event.distanceKm))
    ? nextLeg.reduce((sum, event) => sum + event.distanceKm!, 0) : null;
  const arrivalLabel = (stop: Stop) => {
    if (activeRoute?.executionProjection?.selectionChangedAt && !stop.arrival?.estimatedAt) {
      return "Ny körordning – aktuell ETA saknas";
    }
    const value = stop.arrival?.estimatedAt ?? stop.arrival?.plannedAt
      ?? activeRoute?.workdayTimeline?.find(event => event.type === "service" && event.stopId === stop.id)?.startAt;
    if (!value || !Number.isFinite(new Date(value).getTime())) return null;
    const clock = new Date(value).toLocaleTimeString(lang === "sv" ? "sv-SE" : "en-GB",
      { hour: "2-digit", minute: "2-digit", timeZone: "Europe/Stockholm" });
    return `${stop.arrival?.estimatedAt ? (lang === "sv" ? "Beräknad" : "Estimated") : (lang === "sv" ? "Planerad" : "Planned")} ${clock}`;
  };

  const mapStops = useMemo(
    () => validStops.map((s) => ({
      id: s.id,
      latitude: s.latitude!,
      longitude: s.longitude!,
      sequence: s.sequenceOrder,
      address: s.address,
      status: s.status,
      color: STATUS_COLORS[s.status] ?? c.textTertiary,
    })),
    [validStops, c.textTertiary],
  );

  const straightLineCoords = useMemo(
    () => validStops.map((s) => ({ latitude: s.latitude!, longitude: s.longitude! })),
    [validStops],
  );

  const geometryKey = JSON.stringify([activeRoute?.id, straightLineCoords]);
  const routeGeometry = geometryResult?.key === geometryKey ? geometryResult.geometry : null;
  useEffect(() => {
    if (straightLineCoords.length < 2) {
      setGeometryResult(null);
      return;
    }

    let cancelled = false;
    setGeometryResult(null);
    fetchRouteGeometry(straightLineCoords).then((geometry) => {
      if (!cancelled) {
        setGeometryResult({ key: geometryKey, geometry });
      }
    });
    return () => { cancelled = true; };
  }, [straightLineCoords, geometryKey]);

  const polylineCoords = routeGeometry?.coordinates ?? straightLineCoords;
  const routeLineSource = routeGeometry?.source ?? "fallback";

  const launchNavigation = async (stop: Stop, app: NavigationApp) => {
    const destination = getVerifiedNavigationDestination(stop);
    if (!destination) {
      Alert.alert(t("map.navigationBlocked"), t("map.navigationUnverified"));
      return;
    }
    if (Platform.OS !== "web") {
      await Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    const label = navigationAppLabel(app);
    const url = buildNavigationUrl(app, destination);
    Alert.alert(
      t("map.openNavigation"),
      t("map.openNavigationMessage", { app: label, address: destination.address }),
      [
        { text: t("map.cancel"), style: "cancel" },
        {
          text: t("map.openApp", { app: label }),
          onPress: () => {
            Linking.openURL(url).catch(() => {
              Alert.alert(t("map.navigationFailed"), t("map.navigationFailedMessage", { app: label }));
            });
          },
        },
      ],
    );
  };

  const openNavigation = (stop: Stop) => {
    const destination = getVerifiedNavigationDestination(stop);
    if (!destination) {
      Alert.alert(t("map.navigationBlocked"), t("map.navigationUnverified"));
      return;
    }
    const apps = availableNavigationApps();
    if (apps.length === 1) {
      void launchNavigation(stop, apps[0]);
      return;
    }
    Alert.alert(
      t("map.chooseNavigationApp"),
      t("map.destinationLabel", { address: destination.address }),
      [
        ...apps.map((app) => ({
          text: navigationAppLabel(app),
          onPress: () => void launchNavigation(stop, app),
        })),
        { text: t("map.cancel"), style: "cancel" as const },
      ],
    );
  };

  return (
    <ScrollView style={[styles.container, { backgroundColor: c.background }]}
      contentContainerStyle={{ paddingTop: insets.top + 8, paddingBottom: tabBarHeight + 20 }}
      testID="driver-map-screen">
      <View style={{ height: 300, margin: 12, borderRadius: 20, overflow: "hidden", borderWidth: 1, borderColor: c.border }}>
      <NativeMap
        stops={mapStops}
        polylineCoords={polylineCoords}
        primaryColor={c.primary}
        outlineColor={c.surface}
        routeSource={routeLineSource}
        bottomPadding={0}
        nextStopId={nextStop?.id}
        selectedStopId={previewStop?.id}
        onSelectStop={setPreviewStop}
        viewportCommand={viewportCommand}
      />
      <View style={{ position: "absolute", right: 12, bottom: 22, gap: 6 }}>
        {(["in", "out", "fit"] as const).map(type => (
          <Pressable key={type} accessibilityRole="button"
            accessibilityLabel={type === "in" ? (lang === "sv" ? "Zooma in" : "Zoom in") : type === "out" ? (lang === "sv" ? "Zooma ut" : "Zoom out") : (lang === "sv" ? "Visa hela rutten" : "Show entire route")}
            testID={`map-control-${type}`} onPress={() => command(type)}
            style={{ width: 44, height: 44, borderRadius: 12, backgroundColor: c.surface, borderWidth: 1, borderColor: c.border, alignItems: "center", justifyContent: "center" }}>
            <Feather name={type === "in" ? "plus" : type === "out" ? "minus" : "maximize"} size={20} color={c.primary} />
          </Pressable>
        ))}
      </View>

      {polylineCoords.length > 1 && routeLineSource === "fallback" && (
        <View
          style={[
            styles.routeQualityBadge,
            {
              top: 12,
              backgroundColor: c.surface,
              borderColor: c.border,
            },
          ]}
        >
          <Feather name="alert-circle" size={14} color={c.warning} />
          <Text style={[styles.routeQualityText, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
            {t("map.approximateRoute")}
          </Text>
        </View>
      )}
      </View>

      {!!orderedStops.length && <View style={{ marginHorizontal: 16, gap: 12 }}>
        <View style={{ flexDirection: "row", justifyContent: "space-between" }}>
          <Text style={{ color: c.textSecondary, fontFamily: "Inter_600SemiBold" }}>{lang === "sv" ? "Ruttens framsteg" : "Route progress"}</Text>
          <Text testID="map-progress" style={{ color: c.text }}>{completedCount} / {orderedStops.length} {lang === "sv" ? "utförda" : "completed"}</Text>
        </View>
        <View accessibilityRole="progressbar" accessibilityValue={{ min: 0, max: orderedStops.length, now: completedCount }}
          style={{ height: 5, backgroundColor: c.border, borderRadius: 4, overflow: "hidden" }}>
          <View style={{ width: `${completedCount / orderedStops.length * 100}%`, height: 5, backgroundColor: c.primary }} />
        </View>
        <ScrollView horizontal showsHorizontalScrollIndicator contentContainerStyle={{ gap: 8, paddingVertical: 6 }}>
          {orderedStops.map((stop, index) => <Pressable key={stop.id} accessibilityRole="button"
            accessibilityLabel={`${lang === "sv" ? "Förhandsvisa stopp" : "Preview stop"} ${index + 1}: ${stop.address}`}
            accessibilityState={{ selected: previewStop?.id === stop.id }} testID={`map-preview-${stop.id}`}
            onPress={() => setPreviewStop(stop.id)}
            style={{ minWidth: 48, minHeight: 48, padding: 8, borderRadius: 16, borderWidth: 2,
              borderColor: previewStop?.id === stop.id ? c.primary : c.border,
              backgroundColor: stop.id === nextStop?.id ? c.primary : c.surface, alignItems: "center", justifyContent: "center" }}>
            <Text style={{ color: stop.id === nextStop?.id ? "#fff" : c.text, fontFamily: "Inter_600SemiBold" }}>{index + 1}</Text>
            {stop.status === "completed" && <Feather name="check" size={12} color={c.primary} />}
          </Pressable>)}
        </ScrollView>
        {previewStop && previewStop.id !== nextStop?.id && <View testID="map-stop-preview" accessibilityLiveRegion="polite"
          style={{ padding: 12, borderRadius: 14, backgroundColor: c.surfaceSecondary, gap: 6 }}>
          <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold" }}>{lang === "sv" ? "Förhandsvisar stopp" : "Previewing stop"} {orderedStops.findIndex(stop => stop.id === previewStop.id) + 1}</Text>
          <Text style={{ color: c.text, fontFamily: "Inter_600SemiBold" }}>{previewStop.address}</Text>
          {arrivalLabel(previewStop) && <Text style={{ color: c.textSecondary }}>{arrivalLabel(previewStop)}</Text>}
          <Text style={{ color: c.textSecondary }}>{lang === "sv" ? "Förhandsvisningen ändrar inte nästa stopp eller ruttordningen." : "Previewing does not change the next stop or route order."}</Text>
          <TakeStopNow key={`${previewScope}:${previewStop.id}`} stop={previewStop} />
          <Pressable accessibilityRole="button" onPress={() => setPreview(null)} style={{ minHeight: 44, justifyContent: "center" }}>
            <Text style={{ color: c.primary }}>{lang === "sv" ? "Stäng förhandsvisning" : "Close preview"}</Text>
          </Pressable>
        </View>}
      </View>}

      {isLoading && (
        <View style={[styles.loadingOverlay, { paddingTop: insets.top + 60 }]}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      )}
      {error && (
        <View style={[styles.noRouteOverlay, { paddingTop: insets.top + 54 }]}>
          <View accessibilityRole="alert" style={[styles.noRouteBanner, { backgroundColor: c.surface, borderColor: c.danger }]}>
            <Feather name="alert-circle" size={18} color={c.danger} />
            <Text style={[styles.noRouteText, { color: c.danger, fontFamily: "Inter_500Medium", flex: 1 }]}>
              {localizeError(error, lang, { fallback: t("errors.generic") })}
            </Text>
          </View>
        </View>
      )}

      {nextStop && (
        <View
          style={[
            styles.nextStopCard,
            {
              backgroundColor: c.surface,
              borderColor: c.border,
            },
          ]}
        >
          <View style={styles.nextStopInfo} testID="map-next-stop">
            <Text style={[styles.nextLabel, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>
              {t("map.nextStop")}
            </Text>
            <Text
              numberOfLines={2}
              style={[styles.nextAddress, { color: c.text, fontFamily: "Inter_600SemiBold" }]}
            >
              {getVerifiedNavigationDestination(nextStop)?.address ?? nextStop.address}
            </Text>
            {arrivalLabel(nextStop) && <Text style={{ color: c.textSecondary }}>{arrivalLabel(nextStop)}</Text>}
            {plannedTravelMin != null && Number.isFinite(plannedTravelMin) && <Text style={{ color: c.textSecondary }}>
              {lang === "sv" ? "Planerad resa: " : "Planned travel: "}
              {Math.round(plannedTravelMin)} min
              {plannedDistanceKm != null ? ` · ${plannedDistanceKm.toLocaleString(lang === "sv" ? "sv-SE" : "en-GB", { maximumFractionDigits: 1 })} km` : ""}
            </Text>}
            {!!(nextStop.serviceInstructions || nextStop.notes) && <Text style={{ color: c.textSecondary }}>{nextStop.serviceInstructions || nextStop.notes}</Text>}
            {nextStop.timeWindowStart && (
              <View style={styles.timeMeta}>
                <Feather name="clock" size={12} color={c.textSecondary} />
                <Text style={[styles.timeText, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  {nextStop.timeWindowStart.slice(0, 5)}
                  {nextStop.timeWindowEnd ? ` - ${nextStop.timeWindowEnd.slice(0, 5)}` : ""}
                </Text>
              </View>
            )}
          </View>
          <Pressable
            accessibilityRole="button"
            testID="map-open-stop"
            onPress={() => router.navigate("/(tabs)")}
            style={[styles.stopButton, { borderColor: c.border, backgroundColor: c.surface }]}
          >
            <Feather name="list" size={18} color={c.primary} />
            <Text style={[styles.actionText, { color: c.text }]}>{lang === "sv" ? "Till ruttöversikten" : "Back to route"}</Text>
            <Feather name="chevron-right" size={18} color={c.primary} />
          </Pressable>
          <Pressable
            onPress={() => openNavigation(nextStop)}
            testID="start-navigation"
            accessibilityRole="button"
            accessibilityLabel={t("map.startNavigation")}
            style={({ pressed }) => [
              styles.navButton,
              {
                backgroundColor: getVerifiedNavigationDestination(nextStop) ? c.primary : c.textTertiary,
                opacity: pressed ? 0.85 : 1,
              },
            ]}
          >
            <Feather name="navigation" size={18} color="#FFF" />
            <Text style={[styles.actionText, { color: c.surface }]}>{t("map.startNavigation")}</Text>
          </Pressable>
        </View>
      )}

      {!activeRoute && !isLoading && (
        <View
          style={[styles.noRouteOverlay, { paddingTop: insets.top + 20 }]}
        >
          <View style={[styles.noRouteBanner, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Feather name="info" size={18} color={c.textSecondary} />
            <Text style={[styles.noRouteText, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
              {t("map.noActiveRoute")}
            </Text>
          </View>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  loadingOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    alignItems: "center",
  },
  nextStopCard: {
    marginHorizontal: 16,
    marginTop: 16,
    flexDirection: "column",
    alignItems: "stretch",
    padding: 16,
    borderRadius: 18,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.06,
    shadowRadius: 12,
    elevation: 6,
    gap: 12,
  },
  nextStopInfo: { gap: 7 },
  nextLabel: { fontSize: 11, textTransform: "uppercase", letterSpacing: 1 },
  nextAddress: { fontSize: 20, lineHeight: 26, letterSpacing: -0.4 },
  timeMeta: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  timeText: { fontSize: 13 },
  navButton: {
    minHeight: 54,
    padding: 12,
    flexDirection: "row",
    gap: 9,
    borderRadius: 14,
    alignItems: "center",
    justifyContent: "center",
  },
  stopButton: { minHeight: 48, padding: 12, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 9, borderRadius: 14, borderWidth: 1 },
  actionText: { fontSize: 15, fontFamily: "Inter_600SemiBold", flexShrink: 1 },
  noRouteOverlay: {
    position: "absolute",
    top: 0,
    left: 0,
    right: 0,
    alignItems: "center",
    paddingHorizontal: 16,
  },
  noRouteBanner: {
    flexDirection: "row",
    alignItems: "center",
    gap: 8,
    paddingHorizontal: 16,
    paddingVertical: 12,
    borderRadius: 12,
    borderWidth: 1,
  },
  noRouteText: { fontSize: 14 },
  routeQualityBadge: {
    position: "absolute",
    left: 12,
    zIndex: 20,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    borderWidth: 1,
    borderRadius: 999,
    paddingHorizontal: 10,
    paddingVertical: 7,
    shadowColor: "#000",
    shadowOpacity: 0.12,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  routeQualityText: { fontSize: 12 },
});
