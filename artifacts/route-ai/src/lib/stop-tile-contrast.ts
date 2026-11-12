import { getAccessibleForeground } from "./theme-utils.ts";

export interface StopTileText {
  color: string;
  textShadow: string;
}

const VALID_HEX = /^#[0-9a-f]{6}$/i;

/**
 * Number colour for a vehicle-filled stop tile. Uses the shared WCAG
 * relative-luminance helper so light vehicle colours (orange, yellow,
 * light green) get dark numbers instead of relying on a text shadow.
 * Invalid colours fall back to the previous white text.
 */
export function stopTileText(vehicleHex: string): StopTileText {
  if (!VALID_HEX.test(vehicleHex)) {
    return { color: "#ffffff", textShadow: "0 1px 1px rgba(15, 23, 42, 0.45)" };
  }
  const color = getAccessibleForeground(vehicleHex);
  return {
    color,
    textShadow: color === "#ffffff" ? "0 1px 1px rgba(15, 23, 42, 0.45)" : "none",
  };
}
