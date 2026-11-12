import { useEffect, useRef } from "react";
import type { Route, Stop } from "@workspace/api-client-react";
import { useDirectStopMove } from "./use-direct-stop-move";
import { attemptDirectDispatchMove, type DirectMoveResult, type DirectMoveSnapshot } from "@/lib/direct-dispatch-move";

export function useDirectDispatchDrag(options: {
  identity: string;
  canEdit: boolean;
  routes: Route[];
  stops: Stop[];
  requestMove: (ids: string[], routeId: string | null, index: number, force?: boolean, digest?: string, optimizeTargetRoute?: boolean) => Promise<DirectMoveResult>;
  select: (ids: Set<string>) => void;
  review: (ids: string[], routeId: string | null, index: number) => void;
  notify: (message: string) => void;
}) {
  const { enabled } = useDirectStopMove();
  const current = useRef({ ...options, enabled });
  current.current = { ...options, enabled };
  const scopeVersion = useRef({ key: "", version: 0 });
  const scopeKey = JSON.stringify([options.identity, options.canEdit, enabled]);
  if (scopeVersion.current.key !== scopeKey) {
    scopeVersion.current = { key: scopeKey, version: scopeVersion.current.version + 1 };
  }
  const busy = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const drag = useRef(async (ids: string[], target: string, index: number) => {
    // Do not queue pointer gestures: queued intent can outlive the session.
    if (busy.current) return;
    busy.current = true;
    const initial = current.current;
    const version = scopeVersion.current.version;
    const routeId = target === "unplanned" ? null : target;
    const isCurrent = () => mounted.current && scopeVersion.current.version === version && current.current.identity === initial.identity
      && current.current.canEdit === initial.canEdit && current.current.enabled === initial.enabled;
    initial.select(new Set(ids));
    try {
      const selected = ids.map(id => initial.stops.find(stop => stop.id === id));
      const affected = new Set<string>(routeId ? [routeId] : []);
      for (const stop of selected) if (stop?.routeId) affected.add(stop.routeId);
      const routes = [...affected].map(id => initial.routes.find(route => route.id === id));
      const valid = selected.every(stop => stop?.status === "pending")
        && routes.every(route => route && !["completed", "cancelled"].includes(route.status));
      const snapshot: DirectMoveSnapshot = {
        stopIds: [...ids], routeId, targetIndex: routeId === null ? 0 : index, force: false,
        routeRevisions: routes.filter((route): route is Route => Boolean(route))
          .map(route => ({ routeId: route.id, planRevision: route.planRevision })),
      };
      if (initial.enabled && initial.canEdit && valid) {
        initial.notify("Kontrollerar flytten… Stoppet är markerat. Ingen ändring är sparad ännu.");
      }
      const outcome = await attemptDirectDispatchMove({
        enabled: initial.enabled, canEdit: initial.canEdit && valid, snapshot, isCurrent,
        preview: async payload => {
          const response = await fetch("/api/stops/dispatch-move/preview", {
            method: "POST", credentials: "include", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ ...payload, optimizeTargetRoute: false }),
          });
          if (!response.ok) throw new Error("Preview failed");
          return response.json();
        },
        // The captured canonical mutation closes over exactly the same route revisions.
        commit: (payload, digest) => initial.requestMove(payload.stopIds, payload.routeId, payload.targetIndex, false, digest, false),
      });
      if (outcome === "review") {
        initial.review(ids, routeId, snapshot.targetIndex);
        if (initial.enabled) initial.notify("Flytten behöver granskas. Urvalet finns kvar; ingen automatisk omprövning görs.");
      } else if (outcome === "saved" || outcome === "saved-refresh-failed") {
        // Preserve the selected marker at its confirmed new position.
        if (routeId === null) initial.select(new Set());
        initial.notify(outcome === "saved" ? "Flytten är sparad. Det flyttade stoppet är markerat i tidslinjen."
          : "Flytten har sparats, men vyn kunde inte uppdateras. Ladda om innan du fortsätter.");
      }
    } finally {
      busy.current = false;
    }
  });
  return {
    drag: drag.current, isBusy: () => busy.current,
    canonicalIds: (routeId: string) => current.current.stops.filter(stop => stop.routeId === routeId)
      .sort((a, b) => (a.sequenceOrder ?? Infinity) - (b.sequenceOrder ?? Infinity)).map(stop => stop.id),
  };
}
