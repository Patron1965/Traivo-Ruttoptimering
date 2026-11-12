import React from "react";
import { ArrowRightCircle, Check, CheckCircle, Clock, Mail, Navigation, SkipForward, User, X, XCircle, Wrench, Package } from "lucide-react";

function flatten(value: any): any {
  const input = Array.isArray(value) ? Object.assign({}, ...value.filter(Boolean).map(flatten)) : { ...value };
  const out: any = {};
  for (const [key, val] of Object.entries(input)) {
    if (key === "paddingHorizontal") { out.paddingLeft = val; out.paddingRight = val; }
    else if (key === "paddingVertical") { out.paddingTop = val; out.paddingBottom = val; }
    else if (key === "fontFamily") {
      out.fontFamily = "Inter, sans-serif";
      out.fontWeight = String(val).includes("700") ? 700 : String(val).includes("600") ? 600 : String(val).includes("500") ? 500 : 400;
    } else if (key === "lineHeight" && typeof val === "number") out.lineHeight = `${val}px`;
    else if (key === "fontVariant" && Array.isArray(val)) out.fontVariantNumeric = val.join(" ");
    else if (!key.startsWith("shadow") && key !== "elevation") out[key] = val;
  }
  return out;
}
export const StyleSheet = { create: <T,>(styles: T): T => styles };
export function View({ children, style, testID }: any) {
  return <div data-testid={testID} style={{ display: "flex", flexDirection: "column", boxSizing: "border-box", minWidth: 0, borderStyle: "solid", borderWidth: 0, ...flatten(style) }}>{children}</div>;
}
export function Text({ children, style, numberOfLines }: any) {
  return <span style={{ display: "block", ...(numberOfLines ? { overflow: "hidden", display: "-webkit-box", WebkitLineClamp: numberOfLines, WebkitBoxOrient: "vertical" as const } : {}), ...flatten(style) }}>{children}</span>;
}
type PressableProps = {
  children?: React.ReactNode;
  style?: Record<string, unknown> | unknown[] | ((state: { pressed: boolean }) => unknown);
  disabled?: boolean;
  onPress?: () => void;
  accessibilityLabel?: string;
  accessibilityRole?: string;
  testID?: string;
};
export function Pressable({ children, style, disabled, onPress, accessibilityLabel }: PressableProps) {
  return <button aria-label={accessibilityLabel} disabled={disabled} onClick={onPress} style={{ display: "flex", borderStyle: "solid", borderWidth: 0, cursor: "pointer", ...flatten(typeof style === "function" ? style({ pressed: false }) : style) }}>{children}</button>;
}
const icons: Record<string, any> = { "arrow-right-circle": ArrowRightCircle, check: Check, "check-circle": CheckCircle, clock: Clock, mail: Mail, navigation: Navigation, "skip-forward": SkipForward, user: User, x: X, "x-circle": XCircle, tool: Wrench, package: Package };
export function Feather({ name, size, color }: any) { const Icon = icons[name] || Package; return <Icon size={size} color={color} style={{ flexShrink: 0 }} />; }
Feather.glyphMap = {} as Record<string, unknown>;
export const router = { push: (_: any) => {} };
export const Linking = { openURL: async (_: string) => {} };
export const Alert = { alert: (..._: any[]) => {} };
export const useT = () => ({ lang: "sv", t: (key: string) => key });
export const availableNavigationApps = () => ["maps"];
export const navigationAppLabel = (_: string) => "Kartor";
export const buildNavigationUrl = (..._: any[]) => "#";
export const getVerifiedNavigationDestination = (stop: any) => ({ address: stop.address });
