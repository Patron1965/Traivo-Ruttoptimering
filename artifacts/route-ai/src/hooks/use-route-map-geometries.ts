import { useEffect, useMemo, useState } from "react";
import { fetchRouteGeometry, type RouteGeometryResult } from "@/lib/osrm";
import { routeMapGeometryKey as getRouteMapGeometryKey } from "@/lib/route-map-selection";
import { canCommitRouteGeometry } from "@/lib/route-map-lifecycle";

export interface RouteMapStop {
  id: string;
  address: string;
  latitude: number;
  longitude: number;
  notes?: string | null;
  sequenceOrder?: number | null;
}

export interface RouteMapSelection {
  routeId: string;
  stops: RouteMapStop[];
  waypoints: [number, number][];
  missingCoordinateCount?: number;
}

export type RouteMapGeometryStatus = "loading" | "ready" | "fallback" | "missing" | "error";

export interface RouteMapGeometry extends RouteGeometryResult {
  requestKey: string;
  status: RouteMapGeometryStatus;
  error?: string;
}

export function routeMapGeometryKey(selection: RouteMapSelection): string {
  return getRouteMapGeometryKey(selection.routeId, selection.waypoints);
}

function initialGeometry(selection: RouteMapSelection): RouteMapGeometry {
  const requestKey = routeMapGeometryKey(selection);
  if (selection.waypoints.length < 2) {
    return {
      coordinates: [],
      isFallback: true,
      requestKey,
      status: "missing",
    };
  }

  return {
    coordinates: selection.waypoints,
    isFallback: true,
    requestKey,
    status: "loading",
  };
}

/**
 * Fetch route lines independently so a slow response from a previously
 * selected route can never paint over the current selection. The request key
 * also makes the Leaflet line remount when its source waypoints change.
 */
export function useRouteMapGeometries(
  selections: RouteMapSelection[],
): Map<string, RouteMapGeometry> {
  const selectionsKey = useMemo(
    () => selections.map(routeMapGeometryKey).join(";"),
    [selections],
  );
  const [geometryByRouteId, setGeometryByRouteId] = useState<Map<string, RouteMapGeometry>>(
    () => new Map(),
  );

  useEffect(() => {
    let cancelled = false;
    const next = new Map<string, RouteMapGeometry>();

    selections.forEach((selection) => {
      next.set(selection.routeId, initialGeometry(selection));
    });
    setGeometryByRouteId(next);

    selections
      .filter((selection) => selection.waypoints.length >= 2)
      .forEach((selection) => {
        const requestKey = routeMapGeometryKey(selection);
        fetchRouteGeometry(selection.waypoints)
          .then((result) => {
            if (cancelled) return;
            setGeometryByRouteId((current) => {
              const existing = current.get(selection.routeId);
              if (!canCommitRouteGeometry(existing, requestKey)) return current;
              const updated = new Map(current);
              updated.set(selection.routeId, {
                ...result,
                requestKey,
                status: result.error ? "error" : (result.isFallback ? "fallback" : "ready"),
                error: result.error,
              });
              return updated;
            });
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setGeometryByRouteId((current) => {
              const existing = current.get(selection.routeId);
              if (!canCommitRouteGeometry(existing, requestKey)) return current;
              const updated = new Map(current);
              updated.set(selection.routeId, {
                coordinates: selection.waypoints,
                isFallback: true,
                requestKey,
                status: "error",
                error: error instanceof Error ? error.message : "Route geometry failed",
              });
              return updated;
            });
          });
      });

    return () => {
      cancelled = true;
    };
  }, [selections, selectionsKey]);

  return useMemo(() => {
    const current = new Map<string, RouteMapGeometry>();
    selections.forEach((selection) => {
      const requestKey = routeMapGeometryKey(selection);
      const geometry = geometryByRouteId.get(selection.routeId);
      current.set(
        selection.routeId,
        geometry?.requestKey === requestKey ? geometry : initialGeometry(selection),
      );
    });
    return current;
  }, [geometryByRouteId, selections]);
}