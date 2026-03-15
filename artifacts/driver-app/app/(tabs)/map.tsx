import React, { useMemo } from "react";
import {
  View,
  Text,
  StyleSheet,
  ActivityIndicator,
  Pressable,
  Platform,
  Linking,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQuery } from "@tanstack/react-query";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useTabBarHeight } from "@/hooks/useTabBarHeight";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { api, type Stop } from "@/lib/api";
import NativeMap from "@/components/NativeMap";

const STATUS_COLORS: Record<string, string> = {
  pending: Colors.light.primary,
  completed: Colors.light.success,
  failed: Colors.light.danger,
  skipped: Colors.light.warning,
};

export default function MapTab() {
  const c = Colors.light;
  const { driver } = useAuth();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useTabBarHeight();

  const { data: routes } = useQuery({
    queryKey: ["routes", driver?.id],
    queryFn: () => api.getRoutes(driver?.id),
    enabled: !!driver,
  });

  const activeRoute = routes?.find(
    (r) => r.status === "in_progress" || r.status === "optimized"
  );

  const { data: stops, isLoading } = useQuery({
    queryKey: ["stops", activeRoute?.id],
    queryFn: () => api.getRouteStops(activeRoute!.id),
    enabled: !!activeRoute,
  });

  const validStops = useMemo(
    () => (stops ?? []).filter((s) => s.latitude != null && s.longitude != null)
      .sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99)),
    [stops],
  );

  const nextStop = validStops.find((s) => s.status === "pending");

  const mapStops = useMemo(
    () => validStops.map((s) => ({
      id: s.id,
      latitude: s.latitude!,
      longitude: s.longitude!,
      sequence: s.sequence,
      address: s.address,
      status: s.status,
      color: STATUS_COLORS[s.status] ?? c.textTertiary,
    })),
    [validStops, c.textTertiary],
  );

  const polylineCoords = useMemo(
    () => validStops.map((s) => ({ latitude: s.latitude!, longitude: s.longitude! })),
    [validStops],
  );

  const openNavigation = (stop: Stop) => {
    if (!stop.latitude || !stop.longitude) return;
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    }
    const url = Platform.select({
      ios: `maps://app?daddr=${stop.latitude},${stop.longitude}`,
      android: `google.navigation:q=${stop.latitude},${stop.longitude}`,
      default: `https://www.google.com/maps/dir/?api=1&destination=${stop.latitude},${stop.longitude}`,
    });
    if (url) Linking.openURL(url);
  };

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <NativeMap
        stops={mapStops}
        polylineCoords={polylineCoords}
        primaryColor={c.primary}
        bottomPadding={tabBarHeight}
      />

      {isLoading && (
        <View style={[styles.loadingOverlay, { paddingTop: insets.top + 60 }]}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      )}

      {nextStop && Platform.OS !== "web" && (
        <View
          style={[
            styles.nextStopCard,
            {
              backgroundColor: c.surface,
              borderColor: c.border,
              bottom: tabBarHeight + 16,
            },
          ]}
        >
          <View style={styles.nextStopInfo}>
            <Text style={[styles.nextLabel, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>
              Next Stop
            </Text>
            <Text
              numberOfLines={2}
              style={[styles.nextAddress, { color: c.text, fontFamily: "Inter_600SemiBold" }]}
            >
              {nextStop.address}
            </Text>
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
            onPress={() => openNavigation(nextStop)}
            style={({ pressed }) => [
              styles.navButton,
              { backgroundColor: c.primary, opacity: pressed ? 0.85 : 1 },
            ]}
          >
            <Feather name="navigation" size={22} color="#FFF" />
          </Pressable>
        </View>
      )}

      {!activeRoute && !isLoading && Platform.OS !== "web" && (
        <View
          style={[styles.noRouteOverlay, { paddingTop: insets.top + 20 }]}
        >
          <View style={[styles.noRouteBanner, { backgroundColor: c.surface, borderColor: c.border }]}>
            <Feather name="info" size={18} color={c.textSecondary} />
            <Text style={[styles.noRouteText, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
              No active route to display
            </Text>
          </View>
        </View>
      )}
    </View>
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
    position: "absolute",
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: 16,
    borderWidth: 1,
    shadowColor: "#000",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.12,
    shadowRadius: 12,
    elevation: 6,
    gap: 12,
  },
  nextStopInfo: { flex: 1, gap: 4 },
  nextLabel: { fontSize: 12, textTransform: "uppercase", letterSpacing: 0.5 },
  nextAddress: { fontSize: 16, lineHeight: 22 },
  timeMeta: { flexDirection: "row", alignItems: "center", gap: 4, marginTop: 2 },
  timeText: { fontSize: 13 },
  navButton: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
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
});
