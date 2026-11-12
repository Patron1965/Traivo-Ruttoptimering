import type { Route, Stop } from "@workspace/db";

/**
 * A route lock is a planning invariant, not a best-effort UI preference.
 * Mutation paths use this helper before persisting a customer-stop order so a
 * stale or conflicting write fails instead of silently moving the pinned job.
 */
export class RouteFirstStopLockError extends Error {
  statusCode = 409;
  code = "LOCKED_FIRST_STOP_CONFLICT";

  constructor(message: string) {
    super(message);
    this.name = "RouteFirstStopLockError";
  }
}

export function assertLockedFirstStopOrder(
  route: Pick<Route, "lockedFirstStopId">,
  customerStopIds: readonly string[],
): void {
  if (
    route.lockedFirstStopId != null &&
    customerStopIds[0] !== route.lockedFirstStopId
  ) {
    throw new RouteFirstStopLockError(
      `Ruttens första stopp är låst till ${route.lockedFirstStopId}. Behåll det som första kundstopp eller lås upp rutten först.`,
    );
  }
}

export function assertLockedFirstStopNotRemoved(
  route: Pick<Route, "lockedFirstStopId">,
  removedStopIds: Iterable<string>,
): void {
  if (
    route.lockedFirstStopId != null &&
    new Set(removedStopIds).has(route.lockedFirstStopId)
  ) {
    throw new RouteFirstStopLockError(
      "Det låsta första kundstoppet kan inte tas bort eller arkiveras. Lås upp rutten först.",
    );
  }
}

export function assertLockedFirstStopStillPending(
  route: Pick<Route, "lockedFirstStopId">,
  stop: Pick<Stop, "id" | "routeId" | "status"> | undefined,
): void {
  if (route.lockedFirstStopId == null) return;
  if (
    !stop ||
    stop.id !== route.lockedFirstStopId ||
    stop.routeId == null ||
    stop.status !== "pending"
  ) {
    throw new RouteFirstStopLockError(
      "Rutten har ett låst första kundstopp som inte längre är ett väntande stopp på samma rutt. Ladda om rutten och lås upp eller korrigera planen.",
    );
  }
}