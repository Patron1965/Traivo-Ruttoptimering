import { Platform } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { useTabBarVisibility } from "@/context/TabBarVisibilityContext";
import { computeBottomChromeHeight, MENU_TOGGLE_GAP, MENU_TOGGLE_SIZE } from "./bottom-chrome";

export { MENU_TOGGLE_GAP, MENU_TOGGLE_SIZE };
/** Visible touch row of the classic tab bar (bar itself adds the bottom inset). */
export const TAB_ROW_HEIGHT = Platform.OS === "web" ? 56 : 50;

export function useTabBarHeight(): number {
  const insets = useSafeAreaInsets();
  const { expanded, collapsible } = useTabBarVisibility();
  return computeBottomChromeHeight({ expanded, collapsible, insetBottom: insets.bottom, rowHeight: TAB_ROW_HEIGHT });
}
