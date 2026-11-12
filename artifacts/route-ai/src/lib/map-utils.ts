interface SequencedStop {
  sequenceOrder?: number | null;
}

interface MappableStop extends SequencedStop {
  latitude?: number | null;
  longitude?: number | null;
}

export function sortStopsBySequence<T extends SequencedStop>(stops: T[]): T[] {
  return [...stops].sort(
    (a, b) =>
      (a.sequenceOrder ?? Number.MAX_SAFE_INTEGER) -
      (b.sequenceOrder ?? Number.MAX_SAFE_INTEGER),
  );
}

export function isValidCoordinate(lat?: number | null, lng?: number | null): boolean {
  return (
    typeof lat === "number" &&
    typeof lng === "number" &&
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    Math.abs(lat) > 0.0001 &&
    Math.abs(lng) > 0.0001 &&
    Math.abs(lat) <= 90 &&
    Math.abs(lng) <= 180
  );
}

export function getValidCoordinates<T extends MappableStop>(stops: T[]): [number, number][] {
  return sortStopsBySequence(stops)
    .filter(s => isValidCoordinate(s.latitude, s.longitude))
    .map(s => [s.latitude, s.longitude] as [number, number]);
}

export const TRAIVO_ROUTE_COLORS = [
  "#0891B2", // Cyan 600
  "#059669", // Emerald 600
  "#D97706", // Amber 600
  "#7C3AED", // Violet 600
  "#DB2777", // Pink 600
  "#2563EB", // Blue 600
  "#DC2626", // Red 600
  "#65A30D", // Lime 600
];

export const STATUS_COLORS: Record<string, string> = {
  draft: "#9CA3AF",
  planned: "#06B6D4",
  optimized: "#06B6D4",
  active: "#3B82F6",
  in_progress: "#3B82F6",
  delayed: "#F97316",
  completed: "#10B981",
  cancelled: "#EF4444",
};

export function getRouteColor(
  status?: string | null,
  routeIndex = 0,
  distinguishRoute = false,
  vehicleColor?: string | null,
): string {
  if (vehicleColor && /^#[0-9A-Fa-f]{6}$/.test(vehicleColor)) return vehicleColor;
  if (distinguishRoute) {
    return TRAIVO_ROUTE_COLORS[routeIndex % TRAIVO_ROUTE_COLORS.length];
  }
  if (!status) return TRAIVO_ROUTE_COLORS[routeIndex % TRAIVO_ROUTE_COLORS.length];

  if (["draft", "planned", "optimized"].includes(status.toLowerCase())) {
    return TRAIVO_ROUTE_COLORS[routeIndex % TRAIVO_ROUTE_COLORS.length];
  }

  return STATUS_COLORS[status.toLowerCase()] ?? TRAIVO_ROUTE_COLORS[routeIndex % TRAIVO_ROUTE_COLORS.length];
}
