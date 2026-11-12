import type { Route, Stop, RouteWorkdayEvent } from "@workspace/db";
import { PlanningLockError } from "./planning-lock-service";

/** Shared in-memory counterpart of the commit-time database lock guards. */
export function assertPlanningLockOrder(
  route: Route, original: readonly Stop[], proposed: readonly Stop[],
): void {
  const order = (stops: readonly Stop[]) => [...stops]
    .sort((a, b) => (a.sequenceOrder ?? 0) - (b.sequenceOrder ?? 0))
    .map((stop) => `${stop.id}:${stop.sequenceOrder}`).join("|");
  if (route.optimizationFrozen && order(original) !== order(proposed)) {
    throw new PlanningLockError("Ruttens medlemskap och ordning är frysta. Lås upp först.");
  }
  for (const stop of original) {
    if ((stop.lockedVehicleId || stop.lockedServiceStartAt)
      && !proposed.some((candidate) => candidate.id === stop.id)) {
      throw new PlanningLockError("Uppdraget har ett resurs- eller tidslås. Lås upp före flytt.");
    }
  }
  if (proposed.some((stop) => stop.lockedVehicleId && stop.lockedVehicleId !== route.vehicleId)) {
    throw new PlanningLockError("Uppdragets låsta resurspar motsvarar inte målrutten.");
  }
}

export function assertPlanningLockTimes(
  route: Route, stops: readonly Stop[], events: readonly RouteWorkdayEvent[],
): void {
  const clock = (timeline: readonly RouteWorkdayEvent[]) => JSON.stringify(timeline.map((event) => ({
    type: event.type, stopId: event.stopId ?? null, startAt: event.startAt, endAt: event.endAt,
  })));
  if (route.optimizationFrozen && clock(events) !== clock(route.workdayTimeline ?? [])) {
    throw new PlanningLockError("Ruttens planerade tider är frysta. Lås upp först.");
  }
  for (const stop of stops) {
    if (!stop.lockedServiceStartAt) continue;
    const service = events.find((event) => event.type === "service" && event.stopId === stop.id);
    if (!service || new Date(service.startAt).getTime() !== stop.lockedServiceStartAt.getTime()) {
      throw new PlanningLockError("Ändringen bryter uppdragets exakta planerade servicestart. Lås upp först.");
    }
  }
}
