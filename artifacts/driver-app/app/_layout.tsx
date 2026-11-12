import {
  Inter_400Regular,
  Inter_500Medium,
  Inter_600SemiBold,
  Inter_700Bold,
  useFonts,
} from "@expo-google-fonts/inter";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { Stack } from "expo-router";
import * as SplashScreen from "expo-splash-screen";
import React, { useEffect } from "react";
import { GestureHandlerRootView } from "react-native-gesture-handler";
import { KeyboardProvider } from "react-native-keyboard-controller";
import { SafeAreaProvider } from "react-native-safe-area-context";

import { ErrorBoundary } from "@/components/ErrorBoundary";
import { AuthProvider } from "@/context/AuthContext";
import { SelectedRouteProvider } from "@/context/SelectedRouteContext";
import { DriverAssistanceProvider } from "@/context/DriverAssistanceContext";
import { I18nProvider, useT } from "@/lib/i18n";
import "@/lib/gps-task";
import { prepareDriverPwa } from "@/lib/pwa";
import { installDesktopPhoneFrame } from "@/lib/desktop-phone-frame";

SplashScreen.preventAutoHideAsync();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      refetchOnWindowFocus: false,
      staleTime: 1000 * 30,
      // Local cache query functions must run during airplane-mode cold starts.
      networkMode: "always",
    },
  },
});

function RootLayoutNav() {
  const { t } = useT();
  return (
    <Stack screenOptions={{ headerShown: false }}>
      <Stack.Screen name="login" options={{ headerShown: false }} />
      <Stack.Screen name="activate" options={{ headerShown: false }} />
      <Stack.Screen name="forgot-password" options={{ headerShown: false }} />
      <Stack.Screen name="reset-password" options={{ headerShown: false }} />
      <Stack.Screen name="(tabs)" options={{ headerShown: false }} />
      <Stack.Screen name="explore" options={{ headerShown: false }} />
      <Stack.Screen
        name="proof/[stopId]"
        options={{
          headerShown: true,
          title: t("proof.headerTitle"),
          headerBackTitle: t("common.back"),
        }}
      />
      <Stack.Screen
        name="service/[stopId]"
        options={{
          headerShown: true,
          title: t("service.jobDetails"),
          headerBackTitle: t("common.back"),
        }}
      />
      <Stack.Screen
        name="messages/[routeId]"
        options={{
          headerShown: true,
          title: t("messages.title"),
          headerBackTitle: t("common.back"),
        }}
      />
    </Stack>
  );
}

export default function RootLayout() {
  useEffect(() => { installDesktopPhoneFrame(); }, []);
  useEffect(() => { prepareDriverPwa(); }, []);
  const [fontsLoaded, fontError] = useFonts({
    Inter_400Regular,
    Inter_500Medium,
    Inter_600SemiBold,
    Inter_700Bold,
  });

  useEffect(() => {
    if (fontsLoaded || fontError) {
      SplashScreen.hideAsync();
    }
  }, [fontsLoaded, fontError]);

  if (!fontsLoaded && !fontError) return null;

  return (
    <SafeAreaProvider>
      <I18nProvider>
        <ErrorBoundary>
          <QueryClientProvider client={queryClient}>
            <AuthProvider>
              <DriverAssistanceProvider>
                <SelectedRouteProvider>
                <GestureHandlerRootView style={{ flex: 1 }}>
                  <KeyboardProvider>
                    <RootLayoutNav />
                  </KeyboardProvider>
                </GestureHandlerRootView>
                </SelectedRouteProvider>
              </DriverAssistanceProvider>
            </AuthProvider>
          </QueryClientProvider>
        </ErrorBoundary>
      </I18nProvider>
    </SafeAreaProvider>
  );
}
