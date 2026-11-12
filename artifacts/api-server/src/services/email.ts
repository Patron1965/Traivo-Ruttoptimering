import { db, stopsTable } from "@workspace/db";
import { eq } from "drizzle-orm";
import { notifyRouteCustomers } from "./customer-notifications";
export { sendEmail, sendRecoveryEmail } from "./resend-email";
// Resend is the project's managed connection; actual send failures are returned,
// never redirected to a different provider.
export function isEmailConfigured() { return true; }
export function isRecoveryEmailConfigured() { return true; }
export async function sendDeliveredNotification(stopId: string, routeId: string | null, _vehicleName: string) {
  const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
  if (stop && routeId && stop.status === "completed") await notifyRouteCustomers(routeId, stop.organizationId, "completed", stopId);
}
export async function sendApproachingNotification(stopId: string, routeId: string | null, _vehicleName: string, _eta: number | null) {
  const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
  if (stop && routeId) await notifyRouteCustomers(routeId, stop.organizationId, "approaching");
}
// Failure is not completion. This event is intentionally outside the three
// customer-approved templates; never reuse a completed template for it.
export async function sendFailedNotification(_stopId: string, _routeId: string | null, _vehicleName: string, _reason?: string) {}
