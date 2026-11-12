export const GPS_STALE_AFTER_MS = 120_000;

/** Age belongs to the device sample, never to the HTTP response or UI refresh. */
export function positionFreshness(measuredAt: string | null | undefined, now: number) {
  const timestamp = measuredAt ? Date.parse(measuredAt) : NaN;
  if (!Number.isFinite(timestamp) || timestamp > now + 30_000) {
    return { status: "missing" as const, ageSeconds: null };
  }
  const age = Math.max(0, now - timestamp);
  return {
    status: age > GPS_STALE_AFTER_MS ? "stale" as const : "current" as const,
    ageSeconds: Math.floor(age / 1000),
  };
}
