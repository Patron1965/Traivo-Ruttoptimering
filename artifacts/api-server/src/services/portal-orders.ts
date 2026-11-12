import { and, eq, inArray, isNull, or, sql } from "drizzle-orm";
import { db, stopsTable, routesTable, routeDispatchSnapshotsTable, routeExecutionsTable,
  portalContactsTable, type PortalAccount, type Stop } from "@workspace/db";
import { GetPortalOrdersResponse, GetPortalOrderResponse } from "@workspace/api-zod";
import type { z } from "zod";
type PortalOrder = z.infer<typeof GetPortalOrdersResponse>["items"][number];
type PortalOrderDetail = z.infer<typeof GetPortalOrderResponse>;
import { outgoingStopContext } from "./outgoing-route-service";
import { liveSnapshot, roadArrival, directionalRoad, type RoadAdapter } from "./customer-live-tracking";

const terminal = (status: string) => ["completed", "failed", "skipped"].includes(status);
export const portalAllows = (account: PortalAccount, stop: Pick<Stop, "id" | "organizationId" | "customerId">) =>
  account.organizationId === stop.organizationId &&
  (account.stopIds.includes(stop.id) || (stop.customerId !== null && account.customerIds.includes(stop.customerId)));

export function portalOrderWhere(account: PortalAccount) {
  return and(eq(stopsTable.organizationId, account.organizationId), isNull(stopsTable.archivedAt), or(
    account.stopIds.length ? inArray(stopsTable.id, account.stopIds) : sql`false`,
    account.customerIds.length ? inArray(stopsTable.customerId, account.customerIds) : sql`false`,
  ));
}
const iso = (value: Date | null) => value && Number.isFinite(value.getTime()) ? value.toISOString() : null;
const day = (value: Date | null) => value && Number.isFinite(value.getTime())
  ? new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Stockholm" }).format(value) : null;

async function orderContext(account: PortalAccount, observed: Stop) {
  let context: Awaited<ReturnType<typeof outgoingStopContext>> | null = null;
  try { context = await outgoingStopContext(account.organizationId, observed.id, null); } catch {
    // If any current outgoing evidence exists, never disclose a replacement draft.
    const [evidence] = await db.select({ id: routesTable.id }).from(routesTable)
      .innerJoin(routeDispatchSnapshotsTable, and(eq(routeDispatchSnapshotsTable.routeId, routesTable.id),
        eq(routeDispatchSnapshotsTable.organizationId, routesTable.organizationId),
        eq(routeDispatchSnapshotsTable.planRevision, routesTable.handoffVersion)))
      .where(and(eq(routesTable.organizationId, account.organizationId),
        sql`${routeDispatchSnapshotsTable.stops} @> ${JSON.stringify([{ id: observed.id }])}::jsonb`)).limit(1);
    const [working] = observed.routeId ? await db.select().from(routesTable).where(and(
      eq(routesTable.id, observed.routeId), eq(routesTable.organizationId, account.organizationId))) : [];
    if (evidence || working?.handoffVersion != null) return null;
  }
  const stop = context?.stop ?? observed;
  if (!portalAllows(account, stop)) return null;
  const route = context?.route;
  const [execution] = route ? await db.select().from(routeExecutionsTable).where(and(
    eq(routeExecutionsTable.organizationId, account.organizationId), eq(routeExecutionsTable.routeId, route.id),
    eq(routeExecutionsTable.planVersion, route.planRevision), eq(routeExecutionsTable.driverId, route.handoffDriverId!))) : [];
  let status: PortalOrder["status"] = terminal(stop.status) ? stop.status as "completed" | "failed" | "skipped" : "scheduled";
  if (!terminal(stop.status)) {
    if (route?.status === "cancelled") status = "cancelled";
    else if (route?.handoffStatus === "rejected") status = "unavailable";
    else if (execution?.status === "active" && !execution.endedAt && route?.handoffStatus === "accepted") status = "started";
    else if (execution) status = "paused";
  }
  const order: PortalOrder = { id: stop.id, reference: stop.externalRef, address: stop.address,
    date: day(stop.planningDate ?? stop.timeWindowStart ?? route?.date ?? null),
    timeWindowStart: iso(stop.timeWindowStart), timeWindowEnd: iso(stop.timeWindowEnd), status };
  return { order, stop, route };
}
export { listPortalOrders } from "./portal-order-history";
export async function portalOrderDetail(account: PortalAccount, id: string, road: RoadAdapter = directionalRoad): Promise<PortalOrderDetail | null> {
  const [observed] = await db.select().from(stopsTable).where(and(portalOrderWhere(account), eq(stopsTable.id, id)));
  if (!observed) return null;
  const context = await orderContext(account, observed);
  if (!context) throw Object.assign(new Error("Leveransuppgifterna granskas. Försök igen senare."), { statusCode: 409 });
  const { order, stop, route } = context;
  const snapshot = await liveSnapshot(observed);
  let arrival = snapshot.arrival;
  try { arrival = await roadArrival(snapshot, observed, road); } catch { arrival = { ...arrival, reason: "road_unavailable" }; }
  const finalSnapshot = await liveSnapshot(observed);
  const finalContext = await orderContext(account, observed);
  // External lookups never authorize disclosure. Recheck status, scope and plan.
  const [current] = await db.select().from(stopsTable).where(and(portalOrderWhere(account), eq(stopsTable.id, id)));
  if (!current || !portalAllows(account, current)) return null;
  if (!finalContext || snapshot.key !== finalSnapshot.key ||
      JSON.stringify(finalContext.order) !== JSON.stringify(order) ||
      finalContext.route?.planRevision !== route?.planRevision ||
      finalContext.route?.vehicleId !== route?.vehicleId) {
    throw Object.assign(new Error("Leveransen ändrades. Informationen hämtas på nytt."), { statusCode: 409 });
  }
  if (finalSnapshot.tracking.state !== "live") arrival = finalSnapshot.arrival;
  if (order.status === "started" && finalSnapshot.tracking.state === "live") order.status = "on_the_way";
  const [contact] = route?.vehicleId && ["started", "on_the_way"].includes(order.status)
    ? await db.select({ name: portalContactsTable.name, phone: portalContactsTable.phone }).from(portalContactsTable)
      .where(and(eq(portalContactsTable.organizationId, account.organizationId),
        eq(portalContactsTable.vehicleId, route.vehicleId), eq(portalContactsTable.enabled, true))) : [];
  return { order, completedAt: order.status === "completed" && current.status === "completed" ? current.terminalAt : null,
    contact: contact ?? null, delivery: { brand: null,
    status: order.status === "completed" ? "delivered" : ["failed", "skipped", "cancelled"].includes(order.status) ? "failed"
      : order.status === "on_the_way" ? "on_the_way" : "scheduled",
    address: stop.address, latitude: Number.isFinite(stop.latitude) ? stop.latitude : null,
    longitude: Number.isFinite(stop.longitude) ? stop.longitude : null,
    timeWindowStart: stop.timeWindowStart, timeWindowEnd: stop.timeWindowEnd,
    tracking: { ...finalSnapshot.tracking,
      lastUpdatedAt: finalSnapshot.tracking.lastUpdatedAt ? new Date(finalSnapshot.tracking.lastUpdatedAt) : null,
      freshUntil: finalSnapshot.tracking.freshUntil ? new Date(finalSnapshot.tracking.freshUntil) : null },
    arrival: { ...arrival, plannedAt: arrival.plannedAt ? new Date(arrival.plannedAt) : null,
      estimatedAt: arrival.estimatedAt ? new Date(arrival.estimatedAt) : null,
      calculatedAt: arrival.calculatedAt ? new Date(arrival.calculatedAt) : null } } };
}
