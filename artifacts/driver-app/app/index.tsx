import { useEffect } from "react";
import { router, useLocalSearchParams } from "expo-router";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useAuth } from "@/context/AuthContext";
import Colors from "@/constants/colors";

export default function Index() {
  const { user, isLoading } = useAuth();
  const { routeId } = useLocalSearchParams<{ routeId?: string | string[] }>();
  const requestedRouteId = Array.isArray(routeId) ? routeId[0] : routeId;

  useEffect(() => {
    if (!isLoading) {
      if (user) {
        router.replace({
          pathname: "/(tabs)",
          params: requestedRouteId ? { routeId: requestedRouteId } : {},
        });
      } else {
        router.replace({
          pathname: "/login",
          params: requestedRouteId ? { routeId: requestedRouteId } : {},
        });
      }
    }
  }, [isLoading, user, requestedRouteId]);

  return (
    <View style={[styles.container, { backgroundColor: Colors.light.background }]}>
      <ActivityIndicator size="large" color={Colors.light.primary} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
