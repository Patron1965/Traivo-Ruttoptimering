import React from "react";
import {
  View,
  Text,
  StyleSheet,
  Pressable,
  FlatList,
  ActivityIndicator,
  Platform,
} from "react-native";
import { Feather } from "@expo/vector-icons";
import { router } from "expo-router";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as Haptics from "expo-haptics";
import Colors from "@/constants/colors";
import { useAuth } from "@/context/AuthContext";

export default function LoginScreen() {
  const { drivers, isLoading, selectDriver } = useAuth();
  const insets = useSafeAreaInsets();
  const c = Colors.light;

  const handleSelect = async (driver: (typeof drivers)[0]) => {
    if (Platform.OS !== "web") {
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);
    }
    selectDriver(driver);
    router.replace("/(tabs)");
  };

  if (isLoading) {
    return (
      <View style={[styles.container, { backgroundColor: c.background }]}>
        <ActivityIndicator size="large" color={c.primary} />
      </View>
    );
  }

  return (
    <View
      style={[
        styles.container,
        {
          backgroundColor: c.background,
          paddingTop: Platform.OS === "web" ? 67 : insets.top + 40,
          paddingBottom: Platform.OS === "web" ? 34 : insets.bottom,
        },
      ]}
    >
      <View style={styles.header}>
        <View style={[styles.iconCircle, { backgroundColor: c.primary }]}>
          <Feather name="truck" size={32} color="#FFF" />
        </View>
        <Text style={[styles.title, { color: c.text, fontFamily: "Inter_700Bold" }]}>
          Traivo Route Driver
        </Text>
        <Text style={[styles.subtitle, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
          Select your profile to get started
        </Text>
      </View>

      <FlatList
        data={drivers}
        keyExtractor={(item) => item.id}
        scrollEnabled={drivers.length > 0}
        contentContainerStyle={styles.list}
        renderItem={({ item }) => (
          <Pressable
            onPress={() => handleSelect(item)}
            style={({ pressed }) => [
              styles.driverCard,
              {
                backgroundColor: c.surface,
                borderColor: c.border,
                opacity: pressed ? 0.85 : 1,
                transform: [{ scale: pressed ? 0.98 : 1 }],
              },
            ]}
          >
            <View style={[styles.avatar, { backgroundColor: c.primary + "20" }]}>
              <Feather name="user" size={24} color={c.primary} />
            </View>
            <View style={styles.driverInfo}>
              <Text style={[styles.driverName, { color: c.text, fontFamily: "Inter_600SemiBold" }]}>
                {item.name}
              </Text>
              {item.phone && (
                <Text style={[styles.driverPhone, { color: c.textSecondary, fontFamily: "Inter_400Regular" }]}>
                  {item.phone}
                </Text>
              )}
            </View>
            <Feather name="chevron-right" size={20} color={c.textTertiary} />
          </Pressable>
        )}
        ListEmptyComponent={
          <View style={styles.emptyState}>
            <Feather name="alert-circle" size={40} color={c.textTertiary} />
            <Text style={[styles.emptyText, { color: c.textSecondary, fontFamily: "Inter_500Medium" }]}>
              No drivers found
            </Text>
          </View>
        }
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
  header: {
    alignItems: "center",
    marginBottom: 32,
    paddingHorizontal: 24,
  },
  iconCircle: {
    width: 72,
    height: 72,
    borderRadius: 36,
    alignItems: "center",
    justifyContent: "center",
    marginBottom: 20,
  },
  title: {
    fontSize: 28,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    textAlign: "center",
  },
  list: {
    paddingHorizontal: 20,
    width: "100%",
    maxWidth: 500,
  },
  driverCard: {
    flexDirection: "row",
    alignItems: "center",
    padding: 16,
    borderRadius: 14,
    borderWidth: 1,
    marginBottom: 12,
  },
  avatar: {
    width: 48,
    height: 48,
    borderRadius: 24,
    alignItems: "center",
    justifyContent: "center",
    marginRight: 14,
  },
  driverInfo: {
    flex: 1,
  },
  driverName: {
    fontSize: 17,
    marginBottom: 2,
  },
  driverPhone: {
    fontSize: 14,
  },
  emptyState: {
    alignItems: "center",
    paddingVertical: 40,
    gap: 12,
  },
  emptyText: {
    fontSize: 16,
  },
});
