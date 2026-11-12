import { and, eq, sql } from "drizzle-orm";
import { db, routesTable } from "@workspace/db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
export type PlanStopTarget = {
  planId: string;
  routes: Array<{ routeId: string; planRevision: number }>;
};
export class PlanStopConflictError extends Error {
  readonly statusCode = 409;
  constructor() {
    super("Planen har ändrats. Ladda om planen och försök igen.");
  }
}
const isWorkingRoute = (route: typeof routesTable.$inferSelect) =>
  ["optimized", "in_progress", "draft"].includes(route.status) && !route.optimizationFrozen;

/** Shared guarded membership path; never writes itinerary, outgoing or dispatch history. */
export async function lockPlanStopTarget(
  tx: Transaction, organizationId: string, plan: PlanStopTarget,
) {
  const expected = new Map(plan.routes.map((route) => [route.routeId, route.planRevision]));
  if (!expected.size || expected.size !== plan.routes.length) throw new PlanStopConflictError();
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"plan-stop-membership:" + organizationId + ":" + plan.planId}))`);
  for (const routeId of [...expected.keys()].sort()) {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${"dispatch-route:" + routeId}))`);
  }
  const routes = await tx.select().from(routesTable)
    .where(and(eq(routesTable.organizationId, organizationId), eq(routesTable.planId, plan.planId)))
    .orderBy(routesTable.id).for("update");
  if (
    routes.length !== expected.size || !routes.some(isWorkingRoute) ||
    routes.some((route) => expected.get(route.id) !== route.planRevision ||
      route.date.getTime() !== routes[0]?.date.getTime())
  ) throw new PlanStopConflictError();
  return routes;
}

export async function registerPlanStopMembership(
  tx: Transaction, routes: Array<typeof routesTable.$inferSelect>,
  stops: Array<{ id: string; priority: number | null }>,
) {
  const updatedRouteIds: string[] = [];
  for (const route of routes) {
    if (!isWorkingRoute(route)) continue;
    await tx.update(routesTable).set({
      planRevision: sql`${routesTable.planRevision} + 1`,
      ...(route.planningSummary ? { planningSummary: {
        ...route.planningSummary,
        complete: false,
        mandatoryUnplannedStopIds: [
          ...route.planningSummary.mandatoryUnplannedStopIds, ...stops.map((stop) => stop.id),
        ],
        unplanned: [...route.planningSummary.unplanned, ...stops.map((stop) => ({
          stopId: stop.id, priority: stop.priority === 2 ? 2 as const : stop.priority === 1 ? 1 as const : 0 as const,
          reason: "Nytt stopp väntar på manuell tilldelning.",
        }))],
      } } : {}),
    }).where(and(eq(routesTable.id, route.id), eq(routesTable.organizationId, route.organizationId)));
    updatedRouteIds.push(route.id);
  }
  return updatedRouteIds;
}
