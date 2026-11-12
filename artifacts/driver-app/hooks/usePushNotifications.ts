import { useEffect } from "react";
import { Platform } from "react-native";
import * as Notifications from "expo-notifications";
import { api } from "@/lib/api";
import { router } from "expo-router";
import { localizeError } from "@/lib/error-localizer";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowAlert: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
    shouldShowBanner: true,
    shouldShowList: true,
  }),
});

export function usePushNotifications(driverId: string | null | undefined) {
  useEffect(() => {
    if (!driverId) return;

    let responseSubscription: Notifications.Subscription | undefined;
    let mounted = true;

    const openNotificationTarget = (response: Notifications.NotificationResponse | null) => {
      const data = response?.notification.request.content.data as {
        routeId?: string;
        type?: string;
      } | undefined;
      if (!data?.routeId || !mounted) return;
      const review = data.type === "route_changed" ? "1" : undefined;
      router.replace({
        pathname: "/(tabs)",
        params: {
          routeId: data.routeId,
          ...(review ? { review } : {}),
        },
      });
    };

    responseSubscription = Notifications.addNotificationResponseReceivedListener(openNotificationTarget);
    Notifications.getLastNotificationResponseAsync().then(openNotificationTarget).catch(() => {});

    async function registerToken() {
      if (Platform.OS === "web") return;
      try {
        if (Platform.OS === "android") {
          await Notifications.setNotificationChannelAsync("route-updates", {
            name: "Ruttuppdateringar",
            importance: Notifications.AndroidImportance.HIGH,
            vibrationPattern: [0, 250, 250, 250],
          });
        }
        const { status: existingStatus } = await Notifications.getPermissionsAsync();
        let finalStatus = existingStatus;

        if (existingStatus !== "granted") {
          const { status } = await Notifications.requestPermissionsAsync();
          finalStatus = status;
        }

        if (finalStatus !== "granted") return;

        const tokenData = await Notifications.getExpoPushTokenAsync();
        if (tokenData.data && driverId) {
          await api.registerPushToken(driverId, tokenData.data);
        }
      } catch (err) {
        console.warn("[PUSH] Could not register push token:", localizeError(err));
      }
    }

    registerToken();
    return () => {
      mounted = false;
      responseSubscription?.remove();
    };
  }, [driverId]);
}
