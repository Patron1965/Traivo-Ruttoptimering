export type MetricValue = number | string | null;
export interface RouteConsequence {
  routeId: string; routeName: string;
  before: { driveMin: MetricValue; workMin: MetricValue; endAt: MetricValue; windowViolations: MetricValue; stopCount: number };
  after: { driveMin: MetricValue; workMin: MetricValue; endAt: MetricValue; windowViolations: MetricValue; stopCount: number };
}
export interface PlannerRecommendation {
  routeId: string; routeName: string; driverId: string; driverName: string;
  vehicleId: string; vehicleName: string; targetIndex: number; token: string;
  consequences: { status: string; reason?: string; routes?: RouteConsequence[]; unplanned?: { before: number; after: number } };
}
export interface PlannerRecommendations {
  recommendations: PlannerRecommendation[];
  unavailable: Array<{ routeId: string; routeName: string; reason: string }>;
}
export interface AddressPreview {
  kind: "preview" | "unresolved";
  token?: string; message?: string; verification?: "manual" | "exact_match";
  original?: { address: string; latitude: number; longitude: number; sourceRowNumber: number | null };
  proposed?: { address: string; latitude: number; longitude: number };
  consequences?: { status: string; reason?: string };
}
export interface AddressCorrectionInput {
  stopId: string; address: string;
  position?: { latitude: number; longitude: number; confirmed: true };
}

export function manualCorrectionPosition(latitude: string, longitude: string, confirmed: boolean) {
  if (!confirmed || !latitude.trim() || !longitude.trim()) return null;
  const lat = Number(latitude), lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
  return { latitude: lat, longitude: lon, confirmed: true as const };
}

export function metricText(value: MetricValue | undefined, unit = ""): string {
  return value == null ? "Okänt" : `${value}${unit}`;
}
