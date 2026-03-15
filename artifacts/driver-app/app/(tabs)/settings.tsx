import React, { useState, useCallback } from "react";
import {
  View,
  Text,
  StyleSheet,
  ScrollView,
  Pressable,
  Switch,
  TextInput,
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
import { api } from "@/lib/api";

function ScoreGauge({ score }: { score: number }) {
  const c = Colors.light;
  const pct = Math.round(score * 100);
  const color = pct >= 70 ? c.success : pct >= 40 ? c.warning : c.danger;

  return (
    <View style={styles.gaugeContainer}>
      <View style={[styles.gaugeOuter, { borderColor: c.border }]}>
        <View
          style={[
            styles.gaugeInner,
            { backgroundColor: color },
          ]}
        >
          <Text style={[styles.gaugeText, { fontFamily: "Inter_700Bold" }]}>
            {pct}%
          </Text>
        </View>
      </View>
      <Text style={[styles.gaugeLabel, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
        Happiness Score
      </Text>
    </View>
  );
}

export default function SettingsTab() {
  const c = Colors.light;
  const { driver, logout } = useAuth();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useBottomTabBarHeight();
  const queryClient = useQueryClient();

  const { data: stats } = useQuery({
    queryKey: ["driver-stats", driver?.id],
    queryFn: () => api.getDriverStats(driver!.id),
    enabled: !!driver,
  });

  const { data: prefs } = useQuery({
    queryKey: ["driver-prefs", driver?.id],
    queryFn: () => api.getDriverPreferences(driver!.id),
    enabled: !!driver,
  });

  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [maxHours, setMaxHours] = useState("");
  const [avoidNight, setAvoidNight] = useState(false);
  const [prefsEdited, setPrefsEdited] = useState(false);

  React.useEffect(() => {
    if (prefs) {
      setStartTime(prefs.preferredStartTime ?? "");
      setEndTime(prefs.preferredEndTime ?? "");
      setMaxHours(prefs.maxDrivingHours?.toString() ?? "");
      setAvoidNight(prefs.avoidNightDriving);
    }
  }, [prefs]);

  const saveMutation = useMutation({
    mutationFn: () =>
      api.updateDriverPreferences(driver!.id, {
        preferredStartTime: startTime || null,
        preferredEndTime: endTime || null,
        maxDrivingHours: maxHours ? parseFloat(maxHours) : null,
        avoidNightDriving: avoidNight,
      }),
    onSuccess: () => {
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      queryClient.invalidateQueries({ queryKey: ["driver-prefs", driver?.id] });
      setPrefsEdited(false);
    },
  });

  const handleLogout = useCallback(() => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    logout();
    router.replace("/login");
  }, [logout]);

  return (
    <ScrollView
      style={[styles.container, { backgroundColor: c.background }]}
      contentContainerStyle={{
        paddingTop: Platform.OS === "web" ? 67 : insets.top + 12,
        paddingBottom: tabBarHeight + 32,
        paddingHorizontal: 20,
      }}
    >
      <Text style={[styles.screenTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
        Settings
      </Text>

      <View style={[styles.profileCard, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={[styles.profileAvatar, { backgroundColor: c.primary + "20" }]}>
          <Feather name="user" size={28} color={c.primary} />
        </View>
        <View style={styles.profileInfo}>
          <Text style={[styles.profileName, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
            {driver?.name}
          </Text>
          <Text style={[styles.profileDetail, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
            {driver?.phone ?? driver?.email ?? "Driver"}
          </Text>
        </View>
      </View>

      {stats && stats.happinessScore !== null && (
        <View style={[styles.section, { backgroundColor: c.surface, borderColor: c.border }]}>
          <ScoreGauge score={stats.happinessScore} />
          <View style={styles.statsRow}>
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: c.text, fontFamily: "Inter_700Bold" }]}>
                {stats.totalRoutes}
              </Text>
              <Text style={[styles.statLabel, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                Routes
              </Text>
            </View>
            <View style={[styles.statDivider, { backgroundColor: c.border }]} />
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: c.success, fontFamily: "Inter_700Bold" }]}>
                {stats.completedStops}
              </Text>
              <Text style={[styles.statLabel, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                Delivered
              </Text>
            </View>
            <View style={[styles.statDivider, { backgroundColor: c.border }]} />
            <View style={styles.statItem}>
              <Text style={[styles.statValue, { color: c.danger, fontFamily: "Inter_700Bold" }]}>
                {stats.failedStops}
              </Text>
              <Text style={[styles.statLabel, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                Failed
              </Text>
            </View>
          </View>
        </View>
      )}

      <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
        Preferences
      </Text>
      <View style={[styles.section, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.prefRow}>
          <Text style={[styles.prefLabel, { color: c.text, fontFamily: "Inter_500Medium" }]}>
            Preferred Start
          </Text>
          <TextInput
            style={[styles.prefInput, { color: c.text, borderColor: c.border, fontFamily: "Inter_400Regular" }]}
            value={startTime}
            onChangeText={(v) => { setStartTime(v); setPrefsEdited(true); }}
            placeholder="07:00"
            placeholderTextColor={c.textTertiary}
          />
        </View>
        <View style={styles.prefRow}>
          <Text style={[styles.prefLabel, { color: c.text, fontFamily: "Inter_500Medium" }]}>
            Preferred End
          </Text>
          <TextInput
            style={[styles.prefInput, { color: c.text, borderColor: c.border, fontFamily: "Inter_400Regular" }]}
            value={endTime}
            onChangeText={(v) => { setEndTime(v); setPrefsEdited(true); }}
            placeholder="17:00"
            placeholderTextColor={c.textTertiary}
          />
        </View>
        <View style={styles.prefRow}>
          <Text style={[styles.prefLabel, { color: c.text, fontFamily: "Inter_500Medium" }]}>
            Max Hours/Day
          </Text>
          <TextInput
            style={[styles.prefInput, { color: c.text, borderColor: c.border, fontFamily: "Inter_400Regular" }]}
            value={maxHours}
            onChangeText={(v) => { setMaxHours(v); setPrefsEdited(true); }}
            placeholder="8"
            placeholderTextColor={c.textTertiary}
            keyboardType="decimal-pad"
          />
        </View>
        <View style={styles.prefRow}>
          <Text style={[styles.prefLabel, { color: c.text, fontFamily: "Inter_500Medium" }]}>
            Avoid Night Driving
          </Text>
          <Switch
            value={avoidNight}
            onValueChange={(v) => { setAvoidNight(v); setPrefsEdited(true); }}
            trackColor={{ false: c.border, true: c.primary + "80" }}
            thumbColor={avoidNight ? c.primary : "#FFF"}
          />
        </View>

        {prefsEdited && (
          <Pressable
            onPress={() => saveMutation.mutate()}
            disabled={saveMutation.isPending}
            style={({ pressed }) => [
              styles.saveBtn,
              {
                backgroundColor: c.primary,
                opacity: pressed || saveMutation.isPending ? 0.8 : 1,
              },
            ]}
          >
            <Feather name="check" size={18} color="#FFF" />
            <Text style={[styles.saveBtnText, { fontFamily: "Inter_600SemiBold" }]}>
              Save Preferences
            </Text>
          </Pressable>
        )}
      </View>

      <Pressable
        onPress={handleLogout}
        style={({ pressed }) => [
          styles.logoutBtn,
          {
            backgroundColor: c.danger + "10",
            borderColor: c.danger + "30",
            opacity: pressed ? 0.85 : 1,
          },
        ]}
      >
        <Feather name="log-out" size={18} color={c.danger} />
        <Text style={[styles.logoutText, { color: c.danger, fontFamily: "Inter_600SemiBold" }]}>
          Switch Driver
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  screenTitle: { fontSize: 28, marginBottom: 20 },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 20,
    gap: 14,
  },
  profileAvatar: {
    width: 52,
    height: 52,
    borderRadius: 26,
    alignItems: "center",
    justifyContent: "center",
  },
  profileInfo: { flex: 1, gap: 2 },
  profileName: { fontSize: 18 },
  profileDetail: { fontSize: 14 },
  section: {
    borderRadius: 14,
    borderWidth: 1,
    padding: 16,
    marginBottom: 20,
    gap: 16,
  },
  sectionTitle: { fontSize: 17, marginBottom: 8 },
  gaugeContainer: { alignItems: "center", gap: 8 },
  gaugeOuter: {
    width: 96,
    height: 96,
    borderRadius: 48,
    borderWidth: 4,
    alignItems: "center",
    justifyContent: "center",
  },
  gaugeInner: {
    width: 76,
    height: 76,
    borderRadius: 38,
    alignItems: "center",
    justifyContent: "center",
  },
  gaugeText: { fontSize: 22, color: "#FFF" },
  gaugeLabel: { fontSize: 14 },
  statsRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-around",
  },
  statItem: { alignItems: "center", gap: 2 },
  statValue: { fontSize: 22 },
  statLabel: { fontSize: 12 },
  statDivider: { width: 1, height: 36 },
  prefRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  prefLabel: { fontSize: 15, flex: 1 },
  prefInput: {
    width: 100,
    paddingHorizontal: 12,
    paddingVertical: 8,
    borderRadius: 8,
    borderWidth: 1,
    fontSize: 15,
    textAlign: "center",
  },
  saveBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 12,
    borderRadius: 10,
  },
  saveBtnText: { fontSize: 15, color: "#FFF" },
  logoutBtn: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    paddingVertical: 14,
    borderRadius: 12,
    borderWidth: 1,
    marginBottom: 20,
  },
  logoutText: { fontSize: 15 },
});
