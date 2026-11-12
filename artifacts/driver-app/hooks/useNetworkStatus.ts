import { useState, useEffect, useSyncExternalStore } from "react";
import NetInfo, { type NetInfoState } from "@react-native-community/netinfo";
import { Platform } from "react-native";
import { isServerSessionVerified, subscribeToSessionVerification } from "@/lib/api";

export function useNetworkStatus(rawConnectivity = false) {
  const [isOnline, setIsOnline] = useState(true);
  const sessionVerified = useSyncExternalStore(
    subscribeToSessionVerification,
    isServerSessionVerified,
    () => false,
  );

  useEffect(() => {
    if (Platform.OS === "web") {
      const handleOnline = () => setIsOnline(true);
      const handleOffline = () => setIsOnline(false);
      window.addEventListener("online", handleOnline);
      window.addEventListener("offline", handleOffline);
      setIsOnline(navigator.onLine);
      return () => {
        window.removeEventListener("online", handleOnline);
        window.removeEventListener("offline", handleOffline);
      };
    }

    const unsubscribe = NetInfo.addEventListener((state: NetInfoState) => {
      setIsOnline(state.isConnected !== false);
    });

    NetInfo.fetch().then((state) => {
      setIsOnline(state.isConnected !== false);
    });

    return unsubscribe;
  }, []);

  return { isOnline: isOnline && (rawConnectivity || sessionVerified) };
}
