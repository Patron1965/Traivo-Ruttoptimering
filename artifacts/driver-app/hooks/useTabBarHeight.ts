import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

const TAB_BAR_BASE = Platform.OS === "web" ? 84 : 50;

export function useTabBarHeight(): number {
  const insets = useSafeAreaInsets();
  return TAB_BAR_BASE + insets.bottom;
}
