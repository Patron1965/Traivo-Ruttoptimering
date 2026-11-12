import { and, eq } from "drizzle-orm";
import {
  db,
  driversTable,
  notificationsTable,
  usersTable,
  routesTable,
} from "@workspace/db";

/**
 * Persist a targeted route-change notification.  The event key is tenant
 * scoped and unique, so a mobile retry/polling fallback cannot create duplicate
 * alerts for the same dispatched plan version.
 */
export async function notifyDriverRouteChanged(args: {
  organizationId: string;
  routeId: string;
  driverId: string;
  planVersion: number;
  message?: string;
}) {
  const [outgoing] = await db.select({ id: routesTable.id }).from(routesTable).where(and(
    eq(routesTable.id, args.routeId), eq(routesTable.organizationId, args.organizationId),
    eq(routesTable.handoffVersion, args.planVersion), eq(routesTable.dispatchSnapshotVersion, args.planVersion),
    eq(routesTable.handoffDriverId, args.driverId),
  )).limit(1);
  if (!outgoing) return null; // saving a proposal is not a notification/dispatch
  const [driverUser] = await db
    .select({ id: usersTable.id })
    .from(usersTable)
    .innerJoin(driversTable, and(
      eq(driversTable.id, usersTable.driverProfileId),
      eq(driversTable.organizationId, args.organizationId),
    ))
    .where(and(
      eq(usersTable.organizationId, args.organizationId),
      eq(usersTable.driverProfileId, args.driverId),
      eq(driversTable.id, args.driverId),
    ))
    .limit(1);
  if (!driverUser) return null;

  const eventKey = `route-change:${args.routeId}:${args.planVersion}:${args.driverId}`;
  const [notification] = await db
    .insert(notificationsTable)
    .values({
      organizationId: args.organizationId,
      type: "route_changed",
      title: "Route updated",
      message: args.message ?? "Your dispatched route has changed. Refresh before continuing.",
      relatedEntityId: args.routeId,
      recipientUserId: driverUser.id,
      routeId: args.routeId,
      planVersion: args.planVersion,
      eventKey,
    })
    .onConflictDoNothing({
      target: [
        notificationsTable.organizationId,
        notificationsTable.eventKey,
      ],
    })
    .returning();
  return notification ?? null;
}