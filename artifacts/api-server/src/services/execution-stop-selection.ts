import { createHash } from "node:crypto";
import { and, asc, eq } from "drizzle-orm";
import { db, executionEventsTable, type Route, type Stop } from "@workspace/db";

type Database = Pick<typeof db, "select">;
const terminal = (stop: Pick<Stop, "status">) => ["completed", "failed", "skipped"].includes(stop.status);
export function hasPickupLeg(stop: Pick<Stop, "jobType" | "pickupAddress">): boolean {
  return stop.jobType === "pickup_delivery" || !!stop.pickupAddress?.trim();
}

/** Server ordering, not device clocks, determines the last explicit choice. */
export async function readStopSelection(route: Route, stops: Stop[], database: Database = db) {
  const events = await database.select().from(executionEventsTable).where(and(
    eq(executionEventsTable.organizationId, route.organizationId),
    eq(executionEventsTable.routeId, route.id),
    eq(executionEventsTable.planVersion, route.planRevision),
  )).orderBy(asc(executionEventsTable.createdAt), asc(executionEventsTable.id));
  const choice = events.filter(event => event.eventType === "select_next").at(-1);
  const chosen = stops.find(stop => stop.id === choice?.stopId && !terminal(stop));
  const revision = createHash("sha256").update(JSON.stringify([
    route.planRevision, route.handoffDriverId, route.handoffStatus,
    events.map(event => event.id), stops.map(stop => [stop.id, stop.status]),
  ])).digest("hex");
  return { revision, activeStopId: chosen?.id ?? null, changedAt: choice?.createdAt.toISOString() ?? null };
}

export function applyStopSelection(stops: Stop[], activeStopId: string | null): Stop[] {
  if (!activeStopId) return stops;
  const chosen = stops.find(stop => stop.id === activeStopId && !terminal(stop));
  if (!chosen) return stops;
  const ordered = stops.filter(stop => terminal(stop));
  ordered.push(chosen, ...stops.filter(stop => !terminal(stop) && stop.id !== chosen.id));
  return ordered.map((stop, index) => ({ ...stop, sequenceOrder: index + 1 }));
}

export function stopSelectionBlocker(route: Route, stops: Stop[], stopId: string): string | null {
  const target = stops.find(stop => stop.id === stopId);
  if (!target || terminal(target)) return "Stoppet är redan hanterat eller ingår inte längre i utskicket.";
  if (route.status === "cancelled" || route.status === "completed" || route.handoffStatus !== "accepted") {
    return "Kvittera det aktuella utskicket innan du väljer ett stopp.";
  }
  if (route.optimizationFrozen) return "Ruttens ordning är låst. Be trafikledningen låsa upp den först.";
  if (stops.some(stop => stop.status === "in_progress" && stop.id !== stopId)) {
    return "Avsluta det pågående stoppet innan du väljer ett annat.";
  }
  if (route.lockedFirstStopId && route.lockedFirstStopId !== stopId
    && stops.some(stop => stop.id === route.lockedFirstStopId && !terminal(stop))) {
    return "Det låsta förstastoppet måste hanteras först.";
  }
  // A job's pickup and delivery are one composite node. Never split them,
  // nor leave an already started composite job for a different customer.
  if (stops.some(stop => !terminal(stop) && stop.lockedServiceStartAt)) {
    return "Rutten har en låst besökstid. Be trafikledningen ändra ordningen.";
  }
  if ((route.plannerItinerary ?? []).some(item => item.isChargingStop)
    || (route.workdayTimeline ?? []).some(item => item.type === "charging" || item.type === "break")) {
    return "Rutten har planerad laddning eller rast. Be trafikledningen ändra ordningen säkert.";
  }
  if (hasPickupLeg(target) && target.status === "pending") {
    return "Detta uppdrag innehåller hämtning före leverans. Be trafikledningen ändra hela uppdragets ordning.";
  }
  return null;
}
