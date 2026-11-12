export interface DispatchRouteMetrics {
  driveMin: number | null;
  workMin: number | null;
  endAt: string | null;
  windowViolations: number | null;
  stopCount: number;
}
export interface DispatchConsequences {
  status: "verified" | "unknown";
  reason?: string;
  unplanned: { before: number; after: number };
  routes: Array<{
    routeId: string; routeName: string;
    before: DispatchRouteMetrics; after: DispatchRouteMetrics;
  }>;
}
