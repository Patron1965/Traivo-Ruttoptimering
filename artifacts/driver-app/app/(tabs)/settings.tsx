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
  ActivityIndicator,
  Share,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import { useTabBarHeight } from "@/hooks/useTabBarHeight";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { api } from "@/lib/api";
import { useT } from "@/lib/i18n";
import { useDriverAssistance } from "@/context/DriverAssistanceContext";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useOfflineQueueStatus } from "@/hooks/useOfflineQueueStatus";
import { localizeError } from "@/lib/error-localizer";
import { isCurrentAssistanceScope } from "@/lib/mobile-invariants";
import { QueueConflictActions } from "@/components/QueueConflictActions";
import { ArchivePendingQueue } from "@/components/ArchivePendingQueue";

function ScoreGauge({ score }: { score: number }) {
  const c = Colors.light;
  const { t } = useT();
  const pct = score > 1 ? Math.round(score) : Math.round(score * 100);
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
        {t("settings.happinessScore")}
      </Text>
    </View>
  );
}

export default function SettingsTab() {
  const c = Colors.light;
  const { user, driver, isAdmin, logout } = useAuth();
  const { assistedDriver, isAssisting, selection, clearAssistance } = useDriverAssistance();
  const effectiveDriver = isAssisting ? assistedDriver : driver;
  const effectiveScopeKey = effectiveDriver
    ? `${effectiveDriver.id}:${isAssisting ? selection?.routeId ?? "" : "driver"}`
    : null;
  const effectiveScopeRef = React.useRef(effectiveScopeKey);
  effectiveScopeRef.current = effectiveScopeKey;
  const { isOnline } = useNetworkStatus();
  const { t, lang, setLang } = useT();
  const insets = useSafeAreaInsets();
  const tabBarHeight = useTabBarHeight();
  const queryClient = useQueryClient();
  const {
    items: offlineItems,
    archivedCount,
    pending,
    conflicts,
    synced,
    error: offlineQueueError,
    legacyItems,
    legacyPendingCount,
    reclaimLegacyItem,
    safeLegacyRecoveryMetadata,
  } = useOfflineQueueStatus(!isAdmin && !!driver);
  const [legacyReclaimingId, setLegacyReclaimingId] = useState<string | null>(null);
  const [legacyActionError, setLegacyActionError] = useState<string | null>(null);
  const [preferenceError, setPreferenceError] = useState<string | null>(null);

  const handleLegacyReclaim = async (quarantineId: string) => {
    setLegacyReclaimingId(quarantineId);
    setLegacyActionError(null);
    try {
      await reclaimLegacyItem(quarantineId);
    } catch (reclaimError) {
      setLegacyActionError(localizeError(reclaimError, lang, { fallback: t("errors.generic") }));
    } finally {
      setLegacyReclaimingId(null);
    }
  };

  const exportLegacyRecovery = async () => {
    try {
      await Share.share({
        title: "Traivo offline recovery",
        message: JSON.stringify(safeLegacyRecoveryMetadata, null, 2),
      });
    } catch (exportError) {
      setLegacyActionError(localizeError(exportError, lang, { fallback: t("errors.generic") }));
    }
  };

  const {
    data: stats,
    isLoading: statsLoading,
    error: statsError,
    refetch: refetchStats,
  } = useQuery({
    queryKey: ["driver-stats", effectiveScopeKey],
    queryFn: () => api.getDriverStats(effectiveDriver!.id),
    enabled: !!effectiveDriver && (!isAdmin || isAssisting),
  });

  const {
    data: prefs,
    isLoading: prefsLoading,
    error: prefsReadError,
    refetch: refetchPrefs,
  } = useQuery({
    queryKey: ["driver-prefs", effectiveScopeKey],
    queryFn: () => api.getDriverPreferences(effectiveDriver!.id),
    enabled: !!effectiveDriver && (!isAdmin || isAssisting),
  });
  const prefsReady = Boolean(prefs && prefs.driverId === effectiveDriver?.id);
  const settingsReadError = statsError ?? prefsReadError;
  const settingsLoading = Boolean(effectiveDriver && (statsLoading || prefsLoading));

  const [startTime, setStartTime] = useState("");
  const [endTime, setEndTime] = useState("");
  const [maxHours, setMaxHours] = useState("");
  const [avoidNight, setAvoidNight] = useState(false);
  const [prefsEdited, setPrefsEdited] = useState(false);

  React.useEffect(() => {
    setStartTime("");
    setEndTime("");
    setMaxHours("");
    setAvoidNight(false);
    setPrefsEdited(false);
    setPreferenceError(null);
  }, [effectiveScopeKey]);

  React.useEffect(() => {
    if (prefs && prefs.driverId === effectiveDriver?.id) {
      setStartTime(prefs.preferredStartTime ?? "");
      setEndTime(prefs.preferredEndTime ?? "");
      setMaxHours(prefs.maxDrivingHours?.toString() ?? "");
      setAvoidNight(prefs.avoidNightDriving);
    }
  }, [prefs, effectiveDriver?.id]);

  const saveMutation = useMutation({
    mutationFn: ({ driverId }: { driverId: string; scopeKey: string }) =>
      api.updateDriverPreferences(driverId, {
        preferredStartTime: startTime || null,
        preferredEndTime: endTime || null,
        maxDrivingHours: maxHours ? parseFloat(maxHours) : null,
        avoidNightDriving: avoidNight,
      }),
    onSuccess: (_updated, variables) => {
      queryClient.invalidateQueries({ queryKey: ["driver-prefs", variables.scopeKey] });
      if (!isCurrentAssistanceScope(variables.scopeKey, effectiveScopeRef.current)) return;
      if (Platform.OS !== "web") {
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      }
      setPrefsEdited(false);
    },
    onError: (error, variables) => {
      if (!isCurrentAssistanceScope(variables.scopeKey, effectiveScopeRef.current)) return;
      setPreferenceError(localizeError(error, lang, { fallback: t("settings.saveFailed") }));
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
        paddingTop: insets.top + 8,
        paddingBottom: tabBarHeight + 32,
        paddingHorizontal: 20,
      }}
    >
      <Text style={[styles.screenTitle, { color: c.text, fontFamily: "Inter_700Bold" }]}>
        {t("settings.title")}
      </Text>

      <View style={[styles.profileCard, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={[styles.profileAvatar, { backgroundColor: c.primary + "20" }]}>
          <Feather name="user" size={28} color={c.primary} />
        </View>
        <View style={styles.profileInfo}>
          <Text style={[styles.profileName, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
            {isAdmin ? user?.name : driver?.name}
          </Text>
          <Text style={[styles.profileDetail, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
            {isAdmin ? user?.email : driver?.phone ?? driver?.email ?? t("routes.driverFallback")}
          </Text>
        </View>
      </View>

      {(
        <View testID="settings-offline-queue" style={[styles.section, { backgroundColor: c.surface, borderColor: c.border, gap: 12 }]}>
          <View style={styles.queueHeader}>
            <Feather name="refresh-cw" size={18} color={c.primary} />
            <Text style={[styles.prefLabel, { color: c.text, fontFamily: "Inter_700Bold" }]}>{t("settings.offlineSync")}</Text>
          </View>
          <Text style={styles.sectionDescription}>
            {lang === "sv"
              ? "Lokalt sparat arbete och resultat från synkning visas här. Väntande ändringar är inte bekräftade av trafikledningen."
              : "Locally saved work and sync results appear here. Pending changes are not yet acknowledged by dispatch."}
          </Text>
          {pending.length > 0 && (
            <Text style={{ color: c.warning, fontFamily: "Inter_500Medium" }}>
              {t("settings.pendingSync", { count: pending.length })}
            </Text>
          )}
          {!isAdmin && !!driver && <ArchivePendingQueue items={offlineItems} />}
          {[...conflicts, ...pending].map((item) => (
            <View key={`${item.queueType}:${item.id}`} style={[styles.queueItem, { borderColor: c.border }]}>
              <Feather name={item.syncStatus === "conflict" ? "alert-triangle" : "cloud"} size={18} color={item.syncStatus === "conflict" ? c.danger : c.warning} />
              <View style={{ flex: 1, gap: 4 }}>
                <Text style={{ color: c.text, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>
                  {({
                    stopReport: lang === "sv" ? "Stopprapport" : "Stop report",
                    status: lang === "sv" ? "Stoppstatus" : "Stop status",
                    proof: lang === "sv" ? "Leveransbevis" : "Delivery evidence",
                    serviceReport: lang === "sv" ? "Servicerapport" : "Service report",
                    exception: lang === "sv" ? "Avvikelse" : "Exception",
                    routeMessage: lang === "sv" ? "Meddelande" : "Message",
                  })[item.queueType]}
                </Text>
                <Text style={styles.queueDetail}>
                  {item.syncStatus === "conflict"
                    ? lang === "sv" ? "Konflikt – behöver granskas" : "Conflict – needs review"
                    : item.syncStatus === "syncing"
                      ? lang === "sv" ? "Synkning pågår" : "Syncing"
                      : item.syncStatus === "failed"
                        ? lang === "sv" ? "Väntar på nytt försök" : "Waiting to retry"
                        : lang === "sv" ? "Väntar på synkning" : "Waiting to sync"}
                </Text>
                {"stopId" in item && item.stopId && <Text style={styles.queueDetail}>{t("settings.stopId", { id: item.stopId })}</Text>}
                {item.syncStatus === "conflict" && !isAdmin && !!driver && (
                  <QueueConflictActions item={item} items={offlineItems} />
                )}
                {item.syncStatus === "failed" && item.lastError && (
                  <Text style={styles.queueDetail}>{localizeError({ code: item.lastError }, lang)}</Text>
                )}
              </View>
            </View>
          ))}
          {legacyItems.length > 0 && (
            <View style={[styles.queueNotice, { backgroundColor: c.warning + "10", borderColor: c.warning + "40" }]}>
              <Feather name="archive" size={16} color={c.warning} />
              <View style={{ flex: 1, gap: 6 }}>
                <Text style={{ color: c.warning, fontFamily: "Inter_600SemiBold" }}>
                  {t("settings.legacyPending", { count: legacyPendingCount })}
                </Text>
                <Text style={{ color: c.textSecondary, fontSize: 12 }}>
                  {t("settings.legacyDescription")}
                </Text>
                {legacyItems.map((legacyItem) => (
                  <View key={legacyItem.quarantineId} style={[styles.legacyItem, { borderColor: c.border }]}>
                    <View style={{ flex: 1, gap: 2 }}>
                      <Text style={{ color: c.text, fontFamily: "Inter_600SemiBold", fontSize: 12 }}>
                        {legacyItem.queueType} · {legacyItem.stopId ? t("settings.stopId", { id: legacyItem.stopId }) : t("settings.stopMissing")}
                      </Text>
                      <Text style={{ color: c.textTertiary, fontSize: 11, display: "none" }}>
                        {legacyItem.state === "unresolved"
                          ? t("settings.unverified")
                          : legacyItem.state === "reclaimed"
                            ? t("settings.reclaimed")
                            : `Nekad: ${legacyItem.reason ?? "ej behörig"}`}
                      </Text>
                      <Text style={{ color: c.textTertiary, fontSize: 11 }}>
                        {legacyItem.state === "unresolved"
                          ? t("settings.unverified")
                          : legacyItem.state === "reclaimed"
                            ? t("settings.reclaimed")
                            : t("settings.denied", { reason: t("settings.notAuthorized") })}
                      </Text>
                    </View>
                    {legacyItem.state === "unresolved" && legacyItem.stopId && !isAdmin && driver && (
                      <Pressable
                        onPress={() => void handleLegacyReclaim(legacyItem.quarantineId)}
                        disabled={legacyReclaimingId === legacyItem.quarantineId}
                        style={[styles.queueAction, { borderColor: c.primary, opacity: legacyReclaimingId === legacyItem.quarantineId ? 0.5 : 1 }]}
                      >
                        <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold", fontSize: 11 }}>
                          {t("settings.verifyStop")}
                        </Text>
                      </Pressable>
                    )}
                  </View>
                ))}
                <Pressable onPress={() => void exportLegacyRecovery()} style={[styles.queueAction, { borderColor: c.border }]}>
                  <Feather name="download" size={14} color={c.textSecondary} />
                  <Text style={{ color: c.textSecondary, fontFamily: "Inter_600SemiBold", fontSize: 11 }}>
                    {t("settings.exportRecovery")}
                  </Text>
                </Pressable>
              </View>
            </View>
          )}
          {conflicts.length > 0 && (
            <View style={[styles.queueNotice, { backgroundColor: c.danger + "10", borderColor: c.danger + "30" }]}>
              <Feather name="alert-triangle" size={16} color={c.danger} />
              <Text style={{ color: c.danger, flex: 1, fontSize: 13 }}>
                {t("settings.conflicts", { count: conflicts.length })}
              </Text>
            </View>
          )}
          {synced.length > 0 && legacyPendingCount === 0 && (
            <Text style={{ color: c.success, fontFamily: "Inter_500Medium" }}>
              {t("settings.syncedChanges", { count: synced.length })}
            </Text>
          )}
          {archivedCount > 0 && (
            <Text style={styles.queueDetail}>
              {lang === "sv" ? `${archivedCount} arkiverade ändringar sparas lokalt. De har inte markerats som synkade och skickas inte automatiskt.`
                : `${archivedCount} archived changes are retained locally. They are not marked synced and will not be sent automatically.`}
            </Text>
          )}
          {offlineQueueError && (
            <Text style={{ color: c.danger, fontFamily: "Inter_500Medium" }}>
              {offlineQueueError}
            </Text>
          )}
          {legacyActionError && (
            <Text style={{ color: c.danger, fontFamily: "Inter_500Medium" }}>
              {legacyActionError}
            </Text>
          )}
        </View>
      )}

      {isAdmin && (
        <View
          testID={isAssisting ? "settings-live-assistance-active" : "settings-live-assistance-required"}
          accessibilityLabel={isAssisting ? t("settings.liveAssistance") : t("settings.noSelectionBlocked")}
          style={[styles.section, { backgroundColor: c.primary + "10", borderColor: c.primary + "40" }]}
        >
          <Text style={[styles.prefLabel, { color: c.primary, fontFamily: "Inter_600SemiBold" }]}>
            {isAssisting ? t("settings.liveAssistance") : t("settings.adminMode")}
          </Text>
          <Text style={[styles.profileDetail, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
            {isAssisting && effectiveDriver && selection
              ? t("settings.liveDescription", { driver: effectiveDriver.name, route: selection.routeName })
              : t("settings.adminDescription")}
          </Text>
          <Pressable
            testID={isAssisting ? "settings-switch-live-assistance" : "settings-start-live-assistance"}
            accessibilityRole="button"
            accessibilityLabel={isAssisting ? t("settings.switchLiveHelp") : t("settings.startLiveHelp")}
            onPress={() => router.navigate({ pathname: "/(tabs)", params: { assist: "select" } })}
            disabled={!isOnline}
            accessibilityState={{ disabled: !isOnline }}
            style={[styles.assistanceAction, { backgroundColor: c.primary, opacity: isOnline ? 1 : 0.5 }]}
          >
            <Feather name={isAssisting ? "repeat" : "radio"} size={17} color="#FFF" />
            <Text style={[styles.saveBtnText, { fontFamily: "Inter_600SemiBold" }]}>
              {isAssisting ? t("settings.switchLiveHelp") : t("settings.startLiveHelp")}
            </Text>
          </Pressable>
          {!isOnline && (
            <Text testID="settings-live-assistance-offline-blocked" style={{ color: c.warning, fontFamily: "Inter_500Medium" }}>
              {t("settings.liveOfflineBlocked")}
            </Text>
          )}
          {isAssisting && (
            <Pressable
              testID="settings-exit-live-assistance"
              accessibilityRole="button"
              accessibilityLabel={t("settings.exitLiveHelp")}
              onPress={clearAssistance}
              style={[styles.assistanceAction, { borderColor: c.danger, borderWidth: 1 }]}
            >
              <Feather name="x-circle" size={17} color={c.danger} />
              <Text style={{ color: c.danger, fontFamily: "Inter_600SemiBold" }}>{t("settings.exitLiveHelp")}</Text>
            </Pressable>
          )}
        </View>
      )}

      {!!effectiveDriver && settingsLoading && (
        <View
          testID="selected-driver-settings-loading"
          accessibilityRole="progressbar"
          style={[styles.section, styles.settingsReadState, { backgroundColor: c.surface, borderColor: c.border }]}
        >
          <ActivityIndicator color={c.primary} />
          <Text style={{ color: c.textSecondary, fontFamily: "Inter_500Medium", flex: 1 }}>
            {t("settings.loadingDriverSettings", { driver: effectiveDriver.name })}
          </Text>
        </View>
      )}

      {!!effectiveDriver && !settingsLoading && settingsReadError && (
        <View
          testID="selected-driver-settings-read-error"
          accessibilityRole="alert"
          style={[styles.section, { backgroundColor: c.danger + "10", borderColor: c.danger + "40" }]}
        >
          <View style={styles.settingsReadState}>
            <Feather name="alert-circle" size={20} color={c.danger} />
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: c.text, fontFamily: "Inter_700Bold" }}>
                {t("settings.driverSettingsUnavailable")}
              </Text>
              <Text style={{ color: c.textSecondary, fontFamily: "Inter_400Regular" }}>
                {localizeError(settingsReadError, lang, { fallback: t("settings.driverSettingsReadFailed") })}
              </Text>
            </View>
          </View>
          <Pressable
            testID="retry-selected-driver-settings"
            accessibilityRole="button"
            accessibilityLabel={t("settings.retryDriverSettings")}
            onPress={() => {
              void refetchStats();
              void refetchPrefs();
            }}
            style={[styles.assistanceAction, { backgroundColor: c.primary }]}
          >
            <Feather name="refresh-cw" size={17} color="#FFF" />
            <Text style={[styles.saveBtnText, { fontFamily: "Inter_600SemiBold" }]}>
              {t("settings.retryDriverSettings")}
            </Text>
          </Pressable>
        </View>
      )}

      {stats && effectiveDriver && !settingsReadError && (
        <View style={[styles.section, { backgroundColor: c.surface, borderColor: c.border }]}>
          <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_700Bold", marginBottom: 0 }]}>
            {t("settings.statisticsFor", { driver: effectiveDriver.name })}
          </Text>
          {stats.happinessScore !== null && <ScoreGauge score={stats.happinessScore} />}
          <View style={styles.statsGrid}>
            {[
              [t("settings.routes"), stats.totalRoutes],
              [t("settings.completedRoutes"), stats.completedRoutes],
              [t("settings.totalDeliveries"), stats.totalDeliveries],
              [t("settings.delivered"), stats.completedDeliveries],
              [t("settings.failed"), stats.failedDeliveries],
              [t("settings.skipped"), stats.skippedDeliveries],
              [t("settings.onTimeRate"), stats.onTimeRate === null ? "—" : `${Math.round(stats.onTimeRate > 1 ? stats.onTimeRate : stats.onTimeRate * 100)}%`],
              [t("settings.avgService"), stats.avgServiceDurationMin === null ? "—" : `${Math.round(stats.avgServiceDurationMin)} min`],
              [t("settings.distance"), stats.totalDistanceKm === null ? "—" : `${stats.totalDistanceKm.toFixed(1)} km`],
            ].map(([label, value]) => (
              <View key={String(label)} style={[styles.statGridItem, { borderColor: c.border }]}>
                <Text style={[styles.statValue, { color: c.text, fontFamily: "Inter_700Bold" }]}>{value}</Text>
                <Text style={[styles.statLabel, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>{label}</Text>
              </View>
            ))}
          </View>
        </View>
      )}

      {!!effectiveDriver && prefsReady && !settingsReadError && <Text style={[styles.sectionTitle, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
        {t("settings.preferences")}
      </Text>}
      {!!effectiveDriver && prefsReady && !settingsReadError && <View style={[styles.section, { backgroundColor: c.surface, borderColor: c.border }]}>
        {preferenceError && (
          <Text style={{ color: c.danger, fontFamily: "Inter_500Medium" }}>{preferenceError}</Text>
        )}
        <View style={styles.prefRow}>
          <Text style={[styles.prefLabel, { color: c.text, fontFamily: "Inter_500Medium" }]}>
            {t("settings.preferredStart")}
          </Text>
          <TextInput
            testID="preferred-start-time"
            style={[styles.prefInput, { color: c.text, borderColor: c.border, fontFamily: "Inter_400Regular" }]}
            value={startTime}
            onChangeText={(v) => { setStartTime(v); setPrefsEdited(true); }}
            placeholder="07:00"
            placeholderTextColor={c.textTertiary}
          />
        </View>
        <View style={styles.prefRow}>
          <Text style={[styles.prefLabel, { color: c.text, fontFamily: "Inter_500Medium" }]}>
            {t("settings.preferredEnd")}
          </Text>
          <TextInput
            testID="preferred-end-time"
            style={[styles.prefInput, { color: c.text, borderColor: c.border, fontFamily: "Inter_400Regular" }]}
            value={endTime}
            onChangeText={(v) => { setEndTime(v); setPrefsEdited(true); }}
            placeholder="17:00"
            placeholderTextColor={c.textTertiary}
          />
        </View>
        <View style={styles.prefRow}>
          <Text style={[styles.prefLabel, { color: c.text, fontFamily: "Inter_500Medium" }]}>
            {t("settings.maxHours")}
          </Text>
          <TextInput
            testID="max-driving-hours"
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
            {t("settings.avoidNight")}
          </Text>
          <Switch
            testID="avoid-night-driving"
            value={avoidNight}
            onValueChange={(v) => { setAvoidNight(v); setPrefsEdited(true); }}
            trackColor={{ false: c.border, true: c.primary + "80" }}
            thumbColor={avoidNight ? c.primary : "#FFF"}
          />
        </View>
        {prefsEdited && (
          <>
          {isAdmin && !isOnline && (
            <Text testID="preferences-offline-blocked" style={{ color: c.warning, fontFamily: "Inter_500Medium" }}>
              {t("settings.liveOfflineBlocked")}
            </Text>
          )}
          <Pressable
            testID="save-driver-preferences"
            accessibilityRole="button"
            accessibilityLabel={t("settings.savePreferences")}
            onPress={() => effectiveDriver && effectiveScopeKey && saveMutation.mutate({
              driverId: effectiveDriver.id,
              scopeKey: effectiveScopeKey,
            })}
            disabled={saveMutation.isPending || (isAdmin && !isOnline)}
            style={({ pressed }) => [
              styles.saveBtn,
              {
                backgroundColor: c.primary,
                opacity: pressed || saveMutation.isPending || (isAdmin && !isOnline) ? 0.5 : 1,
              },
            ]}
          >
            <Feather name="check" size={18} color="#FFF" />
            <Text style={[styles.saveBtnText, { fontFamily: "Inter_600SemiBold" }]}>
              {t("settings.savePreferences")}
            </Text>
          </Pressable>
          </>
        )}
      </View>}

      <View style={[styles.section, { backgroundColor: c.surface, borderColor: c.border }]}>
        <View style={styles.prefRow}>
          <Text style={[styles.prefLabel, { color: c.text, fontFamily: "Inter_500Medium" }]}>
            {t("settings.language")}
          </Text>
          <View style={[styles.langToggle, { borderColor: c.border }]}>
            {(["sv", "en"] as const).map((l) => {
              const active = lang === l;
              return (
                <Pressable
                  key={l}
                  testID={`language-${l}`}
                  accessibilityRole="button"
                  onPress={() => {
                    if (Platform.OS !== "web") Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
                    setLang(l);
                  }}
                  style={[styles.langOption, { backgroundColor: active ? c.primary : "transparent" }]}
                >
                  <Text style={[styles.langOptionText, {
                    color: active ? "#FFF" : c.textSecondary,
                    fontFamily: active ? "Inter_600SemiBold" : "Inter_500Medium",
                  }]}>{l.toUpperCase()}</Text>
                </Pressable>
              );
            })}
          </View>
        </View>
      </View>

<Pressable testID="settings-explore" onPress={() => router.push("/explore")} style={{ flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 6, paddingVertical: 12 }}>
          <Feather name="compass" size={16} color={c.primary} />
          <Text style={{ color: c.primary, fontFamily: "Inter_600SemiBold", fontSize: 14 }}>Utforska appen utan uppdrag</Text>
        </Pressable>

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
          {isAdmin ? t("settings.logout") : t("settings.switchDriver")}
        </Text>
      </Pressable>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  screenTitle: { fontSize: 26, lineHeight: 32, letterSpacing: -0.8, marginBottom: 20 },
  sectionDescription: { color: Colors.light.textSecondary, fontSize: 14, lineHeight: 21, fontFamily: "Inter_400Regular" },
  queueItem: { flexDirection: "row", alignItems: "flex-start", gap: 10, borderTopWidth: 1, paddingTop: 14, paddingBottom: 2 },
  queueDetail: { color: Colors.light.textSecondary, fontFamily: "Inter_400Regular", fontSize: 12, lineHeight: 18 },
  profileCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: 18,
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
  profileInfo: { flex: 1, gap: 4 },
  profileName: { fontSize: 18 },
  profileDetail: { fontSize: 14 },
  section: {
    borderRadius: 18,
    borderWidth: 1,
    padding: 16,
    marginBottom: 20,
    gap: 16,
  },
  sectionTitle: { fontSize: 15, lineHeight: 21, marginBottom: 8 },
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
  statsGrid: { flexDirection: "row", flexWrap: "wrap", gap: 8 },
  statGridItem: { width: "31%", minWidth: 88, flexGrow: 1, borderWidth: 1, borderRadius: 10, padding: 10, gap: 3 },
  prefRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
  },
  prefLabel: { fontSize: 15, flex: 1 },
  langToggle: {
    flexDirection: "row",
    borderRadius: 8,
    borderWidth: 1,
    overflow: "hidden",
  },
  langOption: {
    paddingHorizontal: 14,
    paddingVertical: 7,
  },
  langOptionText: { fontSize: 14 },
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
    minHeight: 54,
    borderRadius: 14,
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
  queueHeader: { flexDirection: "row", alignItems: "center", gap: 8 },
  queueNotice: { flexDirection: "row", alignItems: "flex-start", gap: 8, borderWidth: 1, borderRadius: 10, padding: 10 },
  legacyItem: { flexDirection: "row", alignItems: "center", gap: 8, borderWidth: 1, borderRadius: 8, padding: 8 },
  queueAction: { minHeight: 44, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 5, borderWidth: 1, borderRadius: 12, paddingHorizontal: 8 },
  assistanceAction: { minHeight: 54, flexDirection: "row", alignItems: "center", justifyContent: "center", gap: 8, borderRadius: 14, paddingHorizontal: 12 },
  settingsReadState: { flexDirection: "row", alignItems: "center", gap: 10 },
});
