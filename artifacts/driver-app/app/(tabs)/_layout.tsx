import { BlurView } from "expo-blur";
import { Tabs } from "expo-router";
import { SymbolView } from "expo-symbols";
import { Feather } from "@expo/vector-icons";
import React from "react";
import { Platform, Pressable, StyleSheet, View, useColorScheme, Text } from "react-native";
import { Redirect } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { router } from "expo-router";

import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";
import { useNetworkStatus } from "@/hooks/useNetworkStatus";
import { useT } from "@/lib/i18n";
import { useDriverAssistance } from "@/context/DriverAssistanceContext";
import { TabBarVisibilityProvider, useTabBarVisibility } from "@/context/TabBarVisibilityContext";
import { MENU_TOGGLE_GAP, MENU_TOGGLE_SIZE, TAB_ROW_HEIGHT } from "@/hooks/useTabBarHeight";
import { MENU_TOGGLE_SLOT } from "@/hooks/bottom-chrome";

function MenuToggle() {
  const { expanded, setExpanded } = useTabBarVisibility();
  const insets = useSafeAreaInsets();
  const c = Colors.light;
  // Expanded: narrow slot inside the tab row (reserved via paddingRight on the bar).
  // Collapsed: standalone pill just above the real bottom inset.
  const bottom = insets.bottom + MENU_TOGGLE_GAP;
  const label = expanded ? "Dölj meny" : "Visa meny";
  return (
    <Pressable
      testID="toggle-bottom-menu"
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ expanded }}
      aria-expanded={expanded}
      onPress={() => setExpanded(!expanded)}
      style={({ pressed }) => [
        expanded ? styles.menuToggleSlot : styles.menuToggle,
        expanded
          ? { bottom, opacity: pressed ? 0.6 : 1 }
          : { bottom, backgroundColor: c.surface, borderColor: c.border, opacity: pressed ? 0.75 : 1 },
      ]}
    >
      <Feather name={expanded ? "chevron-down" : "chevron-up"} size={18} color={expanded ? c.textSecondary : c.primary} />
      <Text style={[expanded ? styles.menuToggleSlotText : styles.menuToggleText, { color: expanded ? c.textSecondary : c.text }]}>
        {expanded ? "Dölj" : label}
      </Text>
    </Pressable>
  );
}

function OfflineBanner() {
  const { t } = useT();
  const { isOfflineRestored } = useAuth();
  return (
    <View style={styles.offlineBanner}>
      <Feather name="wifi-off" size={16} color={Colors.light.warning} />
      <Text testID="offline-session-banner" style={styles.offlineText}>
        {t(isOfflineRestored ? "tabs.offlineRestored" : "tabs.offline")}
      </Text>
    </View>
  );
}

function AssistanceBanner() {
  const { selection, isAssisting, clearAssistance } = useDriverAssistance();
  const { t } = useT();
  if (!isAssisting || !selection) return null;
  return (
    <View style={[styles.assistanceBanner, { backgroundColor: Colors.light.warning + "20", borderBottomColor: Colors.light.warning + "50" }]}>
      <Feather name="radio" size={14} color={Colors.light.warning} />
      <Pressable
        testID="switch-live-assistance"
        accessibilityRole="button"
        accessibilityLabel={`${t("settings.switchLiveHelp")}: ${selection.driver.name}, ${selection.routeName}`}
        onPress={() => router.navigate({ pathname: "/(tabs)", params: { assist: "select" } })}
        style={styles.assistanceIdentity}
      >
        <Text numberOfLines={1} style={[styles.assistanceTitle, { color: Colors.light.text }]}>
          {t("settings.liveAssistance")} · {selection.driver.name}
        </Text>
        <Text numberOfLines={1} style={[styles.assistanceRoute, { color: Colors.light.textSecondary }]}>
          {selection.routeName} · {t("settings.switchLiveHelp")}
        </Text>
      </Pressable>
      <Pressable
        testID="exit-live-assistance"
        accessibilityRole="button"
        accessibilityLabel={`${t("settings.exitLiveHelp")}: ${selection.driver.name}`}
        onPress={clearAssistance}
        hitSlop={10}
      >
        <Feather name="x" size={20} color={Colors.light.danger} />
      </Pressable>
    </View>
  );
}

function ClassicTabLayout() {
  return (
    <TabBarVisibilityProvider collapsible>
      <ClassicTabs />
    </TabBarVisibilityProvider>
  );
}

function ClassicTabs() {
  const { expanded } = useTabBarVisibility();
  const colorScheme = useColorScheme();
  const isDark = colorScheme === "dark";
  const isIOS = Platform.OS === "ios";
  const isWeb = Platform.OS === "web";
  const insets = useSafeAreaInsets();
  const c = Colors.light;
  const { isOnline } = useNetworkStatus();
  const { t } = useT();

  return (
    <>
      {!isOnline && <OfflineBanner />}
      <AssistanceBanner />
      <Tabs
        screenOptions={{
          tabBarActiveTintColor: c.primary,
          tabBarInactiveTintColor: c.textSecondary,
          headerShown: false,
          tabBarStyle: {
            position: "absolute",
            backgroundColor: isIOS ? "transparent" : c.surface,
            borderTopWidth: isWeb ? 1 : 0,
            borderTopColor: c.border,
            elevation: 0,
            ...(expanded ? {} : { display: "none" as const }),
            // Touch row + real safe-area inset (bottom tabs already pads by insets.bottom).
            height: TAB_ROW_HEIGHT + insets.bottom,
            // Reserve a narrow fourth slot for the in-row "Dölj" toggle.
            paddingRight: MENU_TOGGLE_SLOT,
          },
          tabBarLabelStyle: {
            fontFamily: "Inter_500Medium",
            fontSize: 12,
          },
          tabBarBackground: () =>
            isIOS ? (
              <BlurView
                intensity={100}
                tint="light"
                style={StyleSheet.absoluteFill}
              />
            ) : isWeb ? (
              <View
                style={[
                  StyleSheet.absoluteFill,
                  { backgroundColor: c.surface },
                ]}
              />
            ) : null,
        }}
      >
        <Tabs.Screen
          name="index"
          options={{
            title: t("tabs.routes"),
            tabBarIcon: ({ color, focused }) =>
              isIOS ? (
                <SymbolView name="list.bullet" tintColor={color} size={22} />
              ) : (
                <Feather name="list" size={22} color={focused ? c.primary : c.textSecondary} />
              ),
          }}
        />
        <Tabs.Screen
          name="map"
          options={{
            title: t("tabs.map"),
            tabBarIcon: ({ color, focused }) =>
              isIOS ? (
                <SymbolView name="map" tintColor={color} size={22} />
              ) : (
                <Feather name="map" size={22} color={focused ? c.primary : c.textSecondary} />
              ),
          }}
        />
        <Tabs.Screen
          name="settings"
          options={{
            title: t("tabs.settings"),
            tabBarIcon: ({ color, focused }) =>
              isIOS ? (
                <SymbolView name="gearshape" tintColor={color} size={22} />
              ) : (
                <Feather name="settings" size={22} color={focused ? c.primary : c.textSecondary} />
              ),
          }}
        />
      </Tabs>
      <MenuToggle />
    </>
  );
}

export default function TabLayout() {
  const { user, isLoading } = useAuth();

  if (!isLoading && !user) {
    return <Redirect href="/login" />;
  }

  // Classic tabs on every platform (incl. iOS 26) so the explicit
  // Dölj/Visa meny control is available everywhere; NativeTabs cannot be collapsed.
  return <ClassicTabLayout />;
}

const styles = StyleSheet.create({
  offlineBanner: {
    backgroundColor: Colors.light.warningSurface,
    paddingVertical: 6,
    paddingHorizontal: 12,
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    zIndex: 999,
  },
  offlineText: {
    color: Colors.light.warning,
    fontSize: 13,
    fontFamily: "Inter_500Medium",
    flexShrink: 1,
  },
  assistanceBanner: {
    minHeight: 48,
    paddingHorizontal: 14,
    paddingVertical: 7,
    flexDirection: "row",
    alignItems: "center",
    gap: 10,
    borderBottomWidth: 1,
    zIndex: 998,
  },
  menuToggle: {
    position: "absolute",
    right: 12,
    height: MENU_TOGGLE_SIZE,
    minWidth: MENU_TOGGLE_SIZE,
    paddingHorizontal: 12,
    borderRadius: MENU_TOGGLE_SIZE / 2,
    borderWidth: 1,
    flexDirection: "row",
    alignItems: "center",
    gap: 4,
    zIndex: 1000,
    shadowColor: Colors.light.text,
    shadowOpacity: 0.1,
    shadowRadius: 6,
    shadowOffset: { width: 0, height: 2 },
  },
  menuToggleSlot: {
    position: "absolute",
    right: 6,
    width: 56,
    height: MENU_TOGGLE_SIZE,
    alignItems: "center",
    justifyContent: "center",
    gap: 1,
    zIndex: 1000,
  },
  menuToggleSlotText: { fontSize: 11, fontFamily: "Inter_500Medium" },
  menuToggleText: { fontSize: 13, fontFamily: "Inter_600SemiBold" },
  assistanceIdentity: { flex: 1 },
  assistanceTitle: { fontSize: 13, fontFamily: "Inter_700Bold" },
  assistanceRoute: { fontSize: 11, fontFamily: "Inter_500Medium" },
});
