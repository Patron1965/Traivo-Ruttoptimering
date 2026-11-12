import type { Route, RouteWorkdaySummary, RouteWorkdayTimelineItem, StopStatus } from "@workspace/api-client-react";

export interface OptimizedStopRef {
  stopId: string;
  sequenceOrder: number;
  estimatedArrival: string;
  distanceFromPreviousKm: number;
  isChargingStop?: boolean;
  chargingStationName?: string;
}

export interface OptimizedRouteResult {
  vehicleId: string;
  routeId: string;
  planId: string;
  planRevision: number;
  stops: OptimizedStopRef[];
  distanceKm: number;
  durationMin: number;
  co2EmissionsKg: number;
  chargingStopsInserted?: number;
  geographicOverlapExplanation?: NonNullable<Route["geographicOverlapExplanation"]>;
  workdaySummary?: RouteWorkdaySummary;
  workdayTimeline?: RouteWorkdayTimelineItem[];
  depotSnapshot?: Route["depotSnapshot"];
}

export interface OptimizationTiming {
  totalMs: number;
  profile: "small" | "compact" | "standard" | "custom";
  distanceSource: "cache" | "osrm" | "mixed" | "haversine";
}

export type SaveStatus = "idle" | "saving" | "saved" | "error" | "conflict";

export const STOP_STATUS_LABEL: Record<StopStatus, string> = {
  pending: "Ej utförd",
  in_progress: "Pågår",
  completed: "Klar",
  failed: "Misslyckad",
  skipped: "Hoppad",
};

export const STOP_STATUS_TONE: Record<StopStatus, string> = {
  pending: "bg-muted text-muted-foreground",
  in_progress: "bg-primary/15 text-primary",
  completed: "bg-emerald-500/15 text-emerald-700 dark:text-emerald-300",
  failed: "bg-destructive/15 text-destructive",
  skipped: "bg-amber-500/15 text-amber-800 dark:text-amber-300",
};

export function formatMinutes(min: number): string {
  const m = Math.round(min);
  return m >= 60 ? `${Math.floor(m / 60)} h ${String(m % 60).padStart(2, "0")} min` : `${m} min`;
}
