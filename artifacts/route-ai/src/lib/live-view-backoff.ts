import { PlannerOutgoingViewError } from "./planner-outgoing-view";

export const LIVE_VIEW_POLL_MS = 10_000;

export function retryAfterDelay(value: string | null, now: number): number {
  if (!value?.trim()) return 60_000;
  const seconds = Number(value);
  const delay = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(value) - now;
  return Number.isFinite(delay) && delay > 0 ? Math.max(1000, delay) : 60_000;
}

/** Shared by live-view consumers in this window, isolated by authenticated actor. */
export class LiveViewBackoff {
  private entries = new Map<string, { until: number; error: PlannerOutgoingViewError }>();

  remaining(key: string, now = Date.now()): number {
    const entry = this.entries.get(key);
    if (!entry) return 0;
    if (entry.until <= now) {
      this.entries.delete(key);
      return 0;
    }
    return entry.until - now;
  }

  assertReady(key: string, now = Date.now()): void {
    if (this.remaining(key, now)) throw this.entries.get(key)!.error;
  }

  pause(key: string, retryAfter: string | null, now = Date.now()): PlannerOutgoingViewError {
    for (const [id, entry] of this.entries) if (entry.until <= now) this.entries.delete(id);
    const error = new PlannerOutgoingViewError(
      "Liveuppdateringen är tillfälligt pausad eftersom serverns anropsgräns nåtts. Ett nytt försök görs automatiskt.",
      429, "RATE_LIMITED",
    );
    this.entries.set(key, { until: now + retryAfterDelay(retryAfter, now), error });
    return error;
  }
}
