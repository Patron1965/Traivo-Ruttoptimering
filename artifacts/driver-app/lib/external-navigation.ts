import { Platform } from "react-native";
import { isValidRouteCoordinate, type Stop } from "@/lib/api";

export type NavigationApp = "apple_maps" | "google_maps";

export interface NavigationDestination {
  latitude: number;
  longitude: number;
  address: string;
}

export function getVerifiedNavigationDestination(stop: Stop): NavigationDestination | null {
  const address = stop.navigationAddress?.trim() || stop.address?.trim();
  if (
    stop.navigationVerified !== true
    || !address
    || !isValidRouteCoordinate(stop.latitude, stop.longitude)
  ) {
    return null;
  }
  return {
    latitude: stop.latitude!,
    longitude: stop.longitude!,
    address,
  };
}

export function navigationAppLabel(app: NavigationApp): string {
  return app === "apple_maps" ? "Apple Maps" : "Google Maps";
}

export function buildNavigationUrl(
  app: NavigationApp,
  destination: NavigationDestination,
): string {
  const coordinate = `${destination.latitude},${destination.longitude}`;
  const address = encodeURIComponent(destination.address);
  if (app === "apple_maps") {
    return `http://maps.apple.com/?daddr=${coordinate}&q=${address}&dirflg=d`;
  }
  return `https://www.google.com/maps/dir/?api=1&destination=${coordinate}&travelmode=driving`;
}

export function availableNavigationApps(): NavigationApp[] {
  if (Platform.OS === "ios") return ["apple_maps", "google_maps"];
  return ["google_maps"];
}