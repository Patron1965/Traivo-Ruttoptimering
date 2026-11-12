import { db, routesTable, stopsTable } from "@workspace/db";
import { and, eq, inArray } from "drizzle-orm";

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type ReoptimizationRouteSnapshot = {
  id: string;
  planRevision: number;
  lockedFirstStopId?: string | null;
};

export type ReoptimizationStopSnapshot = {
  id: string;
  status: string;
  routeId: string | null;
  sequenceOrder: number | null;
};

export class ReoptimizationSnapshotConflictError extends Error {
  readonly statusCode = 409;
}

export async function lockAndValidateReoptimizationSnapshot(
  tx: DbTransaction,
  organizationId: string,
  routeSnapshots: ReoptimizationRouteSnapshot[],
  stopSnapshots: ReoptimizationStopSnapshot[],
): Promise<void> {
  const expectedRoutes = new Map(routeSnapshots.map((route) => [route.id, route]));
  const routeIds = [...expectedRoutes.keys()].sort();
  const lockedRoutes = routeIds.length === 0
    ? []
    : await tx
      .select({
        id: routesTable.id,
        planRevision: routesTable.planRevision,
        lockedFirstStopId: routesTable.lockedFirstStopId,
      })
      .from(routesTable)
      .where(and(
        eq(routesTable.organizationId, organizationId),
        inArray(routesTable.id, routeIds),
      ))
      .orderBy(routesTable.id)
      .for("update");
  if (
    lockedRoutes.length !== expectedRoutes.size
    || lockedRoutes.some((route) =>
      route.planRevision !== expectedRoutes.get(route.id)?.planRevision
      || (
        Object.prototype.hasOwnProperty.call(expectedRoutes.get(route.id), "lockedFirstStopId")
        && route.lockedFirstStopId !== expectedRoutes.get(route.id)?.lockedFirstStopId
      )
    )
  ) {
    throw new ReoptimizationSnapshotConflictError(
      "Rutten ändrades under omplaneringen. Ladda om och försök igen.",
    );
  }

  const expectedStops = new Map(stopSnapshots.map((stop) => [stop.id, stop]));
  const stopIds = [...expectedStops.keys()].sort();
  const lockedStops = stopIds.length === 0
    ? []
    : await tx
      .select({
        id: stopsTable.id,
        status: stopsTable.status,
        routeId: stopsTable.routeId,
        sequenceOrder: stopsTable.sequenceOrder,
      })
      .from(stopsTable)
      .where(and(
        eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.id, stopIds),
      ))
      .orderBy(stopsTable.id)
      .for("update");
  if (
    lockedStops.length !== expectedStops.size
    || lockedStops.some((stop) => {
      const expected = expectedStops.get(stop.id);
      return (
        !expected
        || stop.status !== expected.status
        || stop.status !== "pending"
        || stop.routeId !== expected.routeId
        || stop.sequenceOrder !== expected.sequenceOrder
      );
    })
  ) {
    throw new ReoptimizationSnapshotConflictError(
      "Stoppens utförandestatus ändrades under omplaneringen. Ladda om och försök igen.",
    );
  }
}