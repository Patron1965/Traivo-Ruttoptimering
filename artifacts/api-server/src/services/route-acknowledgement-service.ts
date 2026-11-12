import { sql } from "drizzle-orm";
import {
  db,
  routeAcknowledgementsTable,
  routesTable,
} from "@workspace/db";

/** Clears a driver's authority whenever the executable route plan changes. */
export function invalidatedRouteHandoff(now = new Date()) {
  return {
    handoffStatus: "pending" as const,
    handoffVersion: null,
    handoffDriverId: null,
    sentAt: null,
    receivedAt: null,
    openedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    updatedAt: now,
  };
}

/** Working edits preserve an existing outgoing pointer, never reconstruct it.
 * Insertions and cancellations still use invalidatedRouteHandoff.
 */
export function workingRouteHandoff(now = new Date()) {
  const keep = sql`${routesTable.dispatchSnapshotVersion} IS NOT NULL AND ${routesTable.handoffVersion} IS NOT NULL`;
  return {
    handoffStatus: sql`CASE WHEN ${keep} THEN ${routesTable.handoffStatus} ELSE 'pending' END`,
    handoffVersion: sql`CASE WHEN ${keep} THEN ${routesTable.handoffVersion} ELSE NULL END`,
    handoffDriverId: sql`CASE WHEN ${keep} THEN ${routesTable.handoffDriverId} ELSE NULL END`,
    sentAt: sql`CASE WHEN ${keep} THEN ${routesTable.sentAt} ELSE NULL END`,
    receivedAt: sql`CASE WHEN ${keep} THEN ${routesTable.receivedAt} ELSE NULL END`,
    openedAt: sql`CASE WHEN ${keep} THEN ${routesTable.openedAt} ELSE NULL END`,
    acceptedAt: sql`CASE WHEN ${keep} THEN ${routesTable.acceptedAt} ELSE NULL END`,
    rejectedAt: sql`CASE WHEN ${keep} THEN ${routesTable.rejectedAt} ELSE NULL END`,
    rejectionReason: sql`CASE WHEN ${keep} THEN ${routesTable.rejectionReason} ELSE NULL END`,
    updatedAt: now,
  };
}

/** Records dispatch delivery telemetry; route handoff fields own acceptance. */
export async function recordRouteSent(
  organizationId: string,
  routeId: string,
  driverId: string,
) {
  const [acknowledgement] = await db
    .insert(routeAcknowledgementsTable)
    .values({ organizationId, routeId, driverId, status: "sent" })
    .onConflictDoNothing({
      target: [
        routeAcknowledgementsTable.routeId,
        routeAcknowledgementsTable.driverId,
      ],
    })
    .returning();

  return acknowledgement ?? null;
}