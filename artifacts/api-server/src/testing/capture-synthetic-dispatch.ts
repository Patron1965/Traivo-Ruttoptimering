import { and, eq, inArray } from "drizzle-orm";
import { db, routesTable, stopsTable, routeDispatchSnapshotsTable } from "@workspace/db";
import { captureRouteDispatchSnapshot } from "../services/route-dispatch-snapshot-service";

/**
 * Explicit synthetic-fixture dispatch, never imported by production paths.
 * Tests that previously seeded only handoff labels must now seed the authentic
 * planning evidence for that exact synthetic recipient/version as well.
 */
export async function captureSyntheticDispatch(organizationId: string, routeIds: string[]) {
  for (const routeId of routeIds) {
    await db.transaction(async (tx) => {
      const [route] = await tx.select().from(routesTable).where(and(
        eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId),
      )).for("update");
      if (!route?.handoffDriverId || route.handoffVersion !== route.planRevision) {
        throw new Error("Synthetic dispatch must declare an exact recipient and outgoing version");
      }
      const stops = await tx.select().from(stopsTable).where(and(
        eq(stopsTable.routeId, routeId), eq(stopsTable.organizationId, organizationId),
      )).for("update");
      await captureRouteDispatchSnapshot(tx, route, stops, route.handoffDriverId, route.sentAt ?? new Date());
    });
  }
}

/** Dispose only the explicitly identified, synthetic fixture evidence. */
export async function discardSyntheticDispatch(organizationId: string, routeIds: string[]) {
  await db.delete(routeDispatchSnapshotsTable).where(and(
    eq(routeDispatchSnapshotsTable.organizationId, organizationId),
    inArray(routeDispatchSnapshotsTable.routeId, routeIds),
  ));
}
