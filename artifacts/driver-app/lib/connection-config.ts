import { Platform } from "react-native";
import { connectionTarget } from "./connection-target";

export const connection = connectionTarget({
  platform: Platform.OS,
  development: __DEV__,
  domain: process.env.EXPO_PUBLIC_DOMAIN,
  nativePreviewOrigin: process.env.EXPO_PUBLIC_NATIVE_API_ORIGIN,
});
