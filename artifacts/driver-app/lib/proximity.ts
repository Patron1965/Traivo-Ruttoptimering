export interface PositionSample {
  latitude: number;
  longitude: number;
  accuracy: number | null;
  recordedAt: number;
}
export type ProximityResult =
  | { state: "unknown"; reason: "missing" | "stale" | "inaccurate"; distanceM: null }
  | { state: "near" | "far"; distanceM: number };

export const DEFAULT_PROXIMITY_POLICY = { radiusM: 200, maxAgeMs: 60_000, maxAccuracyM: 75 };
export function evaluateProximity(
  sample: PositionSample | null,
  destination: { latitude: number | null; longitude: number | null },
  now = Date.now(),
  policy = DEFAULT_PROXIMITY_POLICY,
): ProximityResult {
  const valid = (lat: unknown, lon: unknown) =>
    typeof lat === "number" && Number.isFinite(lat) && Math.abs(lat) <= 90 &&
    typeof lon === "number" && Number.isFinite(lon) && Math.abs(lon) <= 180;
  if (!sample || !valid(sample.latitude, sample.longitude) || !valid(destination.latitude, destination.longitude)) {
    return { state: "unknown", reason: "missing", distanceM: null };
  }
  if (!Number.isFinite(sample.recordedAt) || now < sample.recordedAt || now - sample.recordedAt > policy.maxAgeMs) {
    return { state: "unknown", reason: "stale", distanceM: null };
  }
  if (sample.accuracy === null || !Number.isFinite(sample.accuracy) || sample.accuracy < 0 || sample.accuracy > policy.maxAccuracyM) {
    return { state: "unknown", reason: "inaccurate", distanceM: null };
  }
  const radians = (n: number) => n * Math.PI / 180;
  const dLat = radians(destination.latitude! - sample.latitude);
  const dLon = radians(destination.longitude! - sample.longitude);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(radians(sample.latitude)) *
    Math.cos(radians(destination.latitude!)) * Math.sin(dLon / 2) ** 2;
  const distanceM = Math.round(6_371_000 * 2 * Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a))));
  // GPS uncertainty must not turn a borderline position into a false far result.
  return { state: distanceM - sample.accuracy > policy.radiusM ? "far" : "near", distanceM };
}
