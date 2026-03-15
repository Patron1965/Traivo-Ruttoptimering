import React, { useCallback } from "react";
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
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useBottomTabBarHeight } from "@react-navigation/bottom-tabs";
import * as Haptics from "expo-haptics";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { api, type Stop, type Route } from "@/lib/api";

const STATUS_CONFIG: Record<string, { color: string; icon: string; label: string }> = {
  pending: { color: Colors.light.textTertiary, icon: "clock", label: "Pending" },
  completed: { color: Colors.light.success, icon: "check-circle", label: "Delivered" },
  failed: { color: Colors.light.danger, icon: "x-circle", label: "Failed" },
  skipped: { color: Colors.light.warning, icon: "skip-forward", label: "Skipped" },
};

function StopCard({
  stop,
  isActive,
  onStatusUpdate,
  isUpdating,
}: {
  stop: Stop;
  isActive: boolean;
  onStatusUpdate: (id: string, status: string) => void;
  isUpdating: boolean;
}) {
  const c = Colors.light;
  const config = STATUS_CONFIG[stop.status] || STATUS_CONFIG.pending;
  const isDone = stop.status === "completed" || stop.status === "failed" || stop.status === "skipped";

  return (
    <View
      style={[
        styles.stopCard,
        {
          backgroundColor: c.surface,
          borderColor: isActive ? c.primary : c.border,
          borderWidth: isActive ? 2 : 1,
        },
      ]}
    >
      <View style={styles.stopHeader}>
        <View style={[styles.sequenceBadge, { backgroundColor: isDone ? config.color + "20" : c.primary + "15" }]}>
          <Text style={[styles.sequenceText, { color: isDone ? config.color : c.primary, fontFamily: "Inter_700Bold" }]}>
            {stop.sequence ?? "?"}
          </Text>
        </View>
        <View style={styles.stopInfo}>
          <Text
            style={[
              styles.stopAddress,
              {
                color: isDone ? c.textTertiary : c.text,
                fontFamily: "Inter_600SemiBold",
                textDecorationLine: isDone ? "line-through" : "none",
              },
            ]}
            numberOfLines={2}
          >
            {stop.address}
          </Text>
          <View style={styles.stopMeta}>
            {stop.timeWindowStart && (
              <View style={styles.metaChip}>
                <Feather name="clock" size={12} color={c.textSecondary} />
                <Text style={[styles.metaText, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  {stop.timeWindowStart.slice(0, 5)}
                  {stop.timeWindowEnd ? ` - ${stop.timeWindowEnd.slice(0, 5)}` : ""}
                </Text>
              </View>
            )}
            {stop.serviceDurationMin && (
              <View style={styles.metaChip}>
                <Feather name="timer" size={12} color={c.textSecondary} />
                <Text style={[styles.metaText, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  {stop.serviceDurationMin} min
                </Text>
              </View>
            )}
          </View>
          {stop.contactName && (
            <Text style={[styles.contactText, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
              {stop.contactName}
            </Text>
          )}
        </View>
        {isDone && (
          <View style={[styles.statusBadge, { backgroundColor: config.color + "15" }]}>
            <Feather name={config.icon as any} size={14} color={config.color} />
          </View>
        )}
      </View>

      {isActive && !isDone && (
        <View style={styles.actionRow}>
          <Pressable
            onPress={() => {
              router.push({ pathname: "/proof/[stopId]", params: { stopId: stop.id } });
            }}
            style={({ pressed }) => [
              styles.actionBtn,
              {
                backgroundColor: c.info + "15",
                borderColor: c.info + "30",
                opacity: pressed ? 0.8 : 1,
              },
            ]}
          >
            <Feather name="camera" size={18} color={c.info} />
            <Text style={[styles.actionLabel, { color: c.info, fontFamily: "Inter_600SemiBold" }]}>
              PoD
            </Text>
          </Pressable>

          <Pressable
            onPress={() => onStatusUpdate(stop.id, "completed")}
            disabled={isUpdating}
            style={({ pressed }) => [
              styles.actionBtn,
              styles.actionBtnWide,
              {
                backgroundColor: c.success,
                opacity: pressed || isUpdating ? 0.8 : 1,
              },
            ]}
          >
            <Feather name="check" size={18} color="#FFF" />
            <Text style={[styles.actionLabel, { color: "#FFF", fontFamily: "Inter_600SemiBold" }]}>
              Delivered
            </Text>
          </Pressable>

          <Pressable
            onPress={() => onStatusUpdate(stop.id, "failed")}
            disabled={isUpdating}
            style={({ pressed }) => [
              styles.actionBtn,
              {
                backgroundColor: c.danger + "15",
                borderColor: c.danger + "30",
                opacity: pressed || isUpdating ? 0.8 : 1,
              },
            ]}
          >
            <Feather name="x" size={18} color={c.danger} />
          </Pressable>

          <Pressable
            onPress={() => onStatusUpdate(stop.id, "skipped")}
            disabled={isUpdating}
            style={({ pressed }) => [
              styles.actionBtn,
              {
                backgroundColor: c.warning + "15",
                borderColor: c.warning + "30",
                opacity: pressed || isUpdating ? 0.8 : 1,
              },
            ]}
          >
            <Feather name="skip-forward" size={18} color={c.warning} />
          </Pressable>
        </View>
      )}
    </View>
  );
}

export default function RoutesTab() {
  const c = Colors.light;
  const { driver } = useAuth();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const queryClient = useQueryClient();

  const { data: routes, isLoading: routesLoading, refetch: refetchRoutes } = useQuery({
    queryKey: ["routes", driver?.id],
    queryFn: () => api.getRoutes(driver?.id),
    enabled: !!driver,
  });

  const activeRoute = routes?.find(
    (r) => r.status === "in_progress" || r.status === "optimized"
  );

  const { data: stops, isLoading: stopsLoading, refetch: refetchStops } = useQuery({
    queryKey: ["stops", activeRoute?.id],
    queryFn: () => api.getRouteStops(activeRoute!.id),
    enabled: !!activeRoute,
  });

  const sortedStops = stops
    ? [...stops].sort((a, b) => (a.sequence ?? 99) - (b.sequence ?? 99))
    : [];

  const activeStop = sortedStops.find(
    (s) => s.status === "pending"
  );

  const completedCount = sortedStops.filter(
    (s) => s.status === "completed"
  ).length;

  const updateMutation = useMutation({
    mutationFn: ({ id, status }: { id: string; status: string }) =>
      api.updateStop(id, { status } as any),
    onSuccess: () => {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      queryClient.invalidateQueries({ queryKey: ["stops", activeRoute?.id] });
      queryClient.invalidateQueries({ queryKey: ["routes", driver?.id] });
    },
    onError: (err: any) => {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error);
      }
      Alert.alert("Update Failed", err?.message || "Could not update stop status. Please try again.");
    },
  });

  const handleStatusUpdate = useCallback(
    (id: string, status: string) => {
      updateMutation.mutate({ id, status });
    },
    [updateMutation],
  );

  const onRefresh = useCallback(() => {
    refetchRoutes();
    if (activeRoute) refetchStops();
  }, [refetchRoutes, refetchStops, activeRoute]);

  const isLoading = routesLoading || stopsLoading;

  return (
    <View style={[styles.container, { backgroundColor: c.background }]}>
      <View
        style={[
          styles.screenHeader,
          {
            paddingTop: Platform.OS === "web" ? 67 : insets.top + 12,
            backgroundColor: c.surface,
            borderBottomColor: c.border,
          },
        ]}
      >
        <View>
          <Text style={[styles.greeting, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
            Hello, {driver?.name?.split(" ")[0] ?? "Driver"}
          </Text>
          <Text style={[styles.headerTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
            {activeRoute ? activeRoute.name : "No Active Route"}
          </Text>
        </View>
        {activeRoute && (
          <View style={[styles.progressChip, { backgroundColor: c.primary + "15" }]}>
            <Text style={[styles.progressText, { color: c.primary, fontFamily: "Inter_700Bold" }]}>
              {completedCount}/{sortedStops.length}
            </Text>
          </View>
        )}
      </View>

      {isLoading ? (
        <View style={styles.centered}>
          <ActivityIndicator size="large" color={c.primary} />
        </View>
      ) : !activeRoute ? (
        <View style={styles.centered}>
          <Feather name="inbox" size={48} color={c.textTertiary} />
          <Text style={[styles.emptyTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
            No active route
          </Text>
          <Text style={[styles.emptySubtitle, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
            Your dispatcher will assign a route to you
          </Text>
        </View>
      ) : (
        <FlatList
          data={sortedStops}
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
          renderItem={({ item }) => (
            <StopCard
              stop={item}
              isActive={item.id === activeStop?.id}
              onStatusUpdate={handleStatusUpdate}
              isUpdating={updateMutation.isPending}
            />
          )}
        />
      )}
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
    paddingBottom: 16,
    borderBottomWidth: 1,
  },
  greeting: { fontSize: 14, marginBottom: 2 },
  headerTitle: { fontSize: 22 },
  progressChip: {
    paddingHorizontal: 14,
    paddingVertical: 8,
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
  listContent: { padding: 16, gap: 12 },
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
});
