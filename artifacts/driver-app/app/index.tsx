import { useEffect } from "react";
import { router } from "expo-router";
import { View, ActivityIndicator, StyleSheet } from "react-native";
import { useAuth } from "@/context/AuthContext";
import Colors from "@/constants/colors";

export default function Index() {
  const { driver, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      if (driver) {
        router.replace("/(tabs)");
      } else {
        router.replace("/login");
      }
    }
  }, [isLoading, driver]);

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
