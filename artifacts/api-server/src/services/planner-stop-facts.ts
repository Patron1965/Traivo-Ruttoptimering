import { createHash } from "node:crypto";
import type { Stop } from "@workspace/db";

/** Entire persisted stop: any change requires a fresh correction preview. */
export function plannerStopDigest(stop: Stop): string {
  return plannerFactsDigest(stop);
}

/** JSON.stringify invokes Date.toJSON before this replacer; instants must not hash as {}. */
export function plannerFactsDigest(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value, (_key, child) =>
    child && typeof child === "object" && !Array.isArray(child)
      ? Object.fromEntries(Object.entries(child).sort(([a], [b]) => a.localeCompare(b))) : child,
  )).digest("hex");
}
