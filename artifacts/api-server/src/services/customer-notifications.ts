import { and, eq } from "drizzle-orm";
import { db, organizationsTable, routesTable, vehiclesTable, customerNotificationAttemptsTable, routeExecutionsTable, deliveryNotificationsTable, stopsTable, auditLogTable } from "@workspace/db";
import { outgoingRoute, outgoingStops } from "./outgoing-route-service";
import { customerNotificationConfigSchema, renderNotification, escapeNotificationHtml } from "./customer-notification-config";
import { existingCustomerTrackingUrl } from "./customer-links";
import { customerTransport, type SubmissionOutcome } from "./customer-notification-transport";
import type { EmailPayload } from "./resend-email";
import { loadOrganizationServicePolicy } from "./organization-service-policy";
import { logger } from "../lib/logger";
import { liveSnapshot } from "./customer-live-tracking";

type Event = "planned" | "approaching" | "completed";
type Transport = {
  configuredProvider: typeof customerTransport.configuredProvider;
  sendSms: (to: string, message: string, organizationId: string) => Promise<boolean | SubmissionOutcome>;
  sendEmail: (payload: EmailPayload & { idempotencyKey?: string }, organizationId: string) => Promise<boolean | SubmissionOutcome>;
};
type Recovery = { id: string; revision: number; recipient: string; actorId: string };
export const recoverableStatuses = ["missing_recipient", "rejected"];
// Opt-in only. Claims are persisted BEFORE network I/O: unknown provider results
// must never be retried automatically and risk duplicate customer messages.
export async function notifyRouteCustomers(routeId: string, organizationId: string, event: Event, completedStopId?: string, transport: Transport = customerTransport, recovery?: Recovery): Promise<true | undefined> {
  try {
    const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, organizationId));
    const config = customerNotificationConfigSchema.safeParse(org?.customerNotifications);
    if (!org || !config.success || !config.data.events[event].enabled) return;
    const [working] = await db.select().from(routesTable).where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
    if (!working?.dispatchSnapshotVersion || working.handoffStatus === "rejected") return;
    if (event === "approaching" && !working.notifyApproaching) return;
    if (event === "completed" && !working.notifyDelivered) return;
    const route = await outgoingRoute(working);
    if (route.status === "cancelled") return;
    if (event === "approaching") {
      const [execution] = await db.select({id:routeExecutionsTable.id}).from(routeExecutionsTable).where(and(
        eq(routeExecutionsTable.routeId, routeId), eq(routeExecutionsTable.organizationId, organizationId),
        eq(routeExecutionsTable.planVersion, route.planRevision), eq(routeExecutionsTable.status, "active"),
      )).limit(1);
      if (!execution) return;
    }
    const stops = await outgoingStops(working);
    const targets = event === "planned" ? stops.filter(s => s.status === "pending")
      : event === "completed" ? stops.filter(s => s.id === completedStopId && s.status === "completed")
      : stops.filter(s => s.status === "pending" || s.status === "in_progress").slice(0, 1);
    const [resource] = route.vehicleId ? await db.select().from(vehiclesTable).where(and(eq(vehiclesTable.id, route.vehicleId), eq(vehiclesTable.organizationId, organizationId))) : [];
    const policy = await loadOrganizationServicePolicy(organizationId);
    const channels = config.data.channel === "both" ? ["sms", "email"] : [config.data.channel];
    const format = (date: unknown, options: Intl.DateTimeFormatOptions) => date ? new Date(date as string).toLocaleString("sv-SE", {timeZone:"Europe/Stockholm", ...options}) : "";
    for (const stop of targets) {
      // Use exactly the public map's accepted-execution/next-destination gates.
      // A missing GPS sample does not prevent notification; an ineligible run does.
      if (event === "approaching" && !(await liveSnapshot(stop)).key) continue;
      const values = {
        customer_name: stop.contactName ?? "", address: stop.address,
        company: org.name, resource_name: resource?.name ?? "",
        date: format(stop.planningDate ?? stop.timeWindowStart ?? route.date, {year:"numeric",month:"2-digit",day:"2-digit"}),
        time_window: stop.timeWindowStart && stop.timeWindowEnd
          ? `${format(stop.timeWindowStart,{hour:"2-digit",minute:"2-digit"})}–${format(stop.timeWindowEnd,{hour:"2-digit",minute:"2-digit"})}` : "",
        tracking_url: await existingCustomerTrackingUrl(stop.id, organizationId) ?? "",
      };
      const template = config.data.events[event];
      for (const channel of channels) {
        // Never send a customer-link SMS with an empty/revoked link or truncate
        // the bearer URL. Existing email settings remain independent.
        if (channel === "sms" && !values.tracking_url) continue;
        const smsMessage = renderNotification(template.sms, values);
        const linkedSmsMessage = smsMessage.includes(values.tracking_url) ? smsMessage : `${smsMessage}\n${values.tracking_url}`;
        const [previous] = recovery ? await db.select().from(customerNotificationAttemptsTable).where(and(
          eq(customerNotificationAttemptsTable.id, recovery.id),
          eq(customerNotificationAttemptsTable.organizationId, organizationId),
          eq(customerNotificationAttemptsTable.stopId, stop.id),
          eq(customerNotificationAttemptsTable.channel, channel),
          eq(customerNotificationAttemptsTable.event, event),
          eq(customerNotificationAttemptsTable.revision, recovery.revision),
        )) : [];
        if (recovery && (!previous || !recoverableStatuses.includes(previous.status))) continue;
        const recipient = recovery?.recipient ?? (channel === "sms" ? stop.contactPhone : stop.contactEmail);
        const permitted = channel === "sms" ? transport.configuredProvider(policy.smsProvider) === "linkmobility" : policy.emailEnabled;
        if (recovery && (!recipient || !permitted)) continue;
        const [claim] = recovery && previous
          ? await db.update(customerNotificationAttemptsTable).set({
            status: "sending", routeId, revision: previous.revision + 1, updatedAt: new Date(),
            history: [...previous.history, { status: previous.status, at: new Date().toISOString(), actorId: recovery.actorId }],
          }).where(and(
            eq(customerNotificationAttemptsTable.id, previous.id),
            eq(customerNotificationAttemptsTable.organizationId, organizationId),
            eq(customerNotificationAttemptsTable.revision, recovery.revision),
            eq(customerNotificationAttemptsTable.status, previous.status),
          )).returning()
          : await db.insert(customerNotificationAttemptsTable).values({
          organizationId, stopId: stop.id, event, channel, routeId,
          status: !recipient ? "missing_recipient" : !permitted ? "channel_unavailable" : "sending",
        }).onConflictDoNothing().returning();
        if (!claim || !recipient || !permitted) continue;
        await db.insert(auditLogTable).values({
          organizationId, userId: recovery?.actorId ?? null,
          action: recovery ? "customer_notification_recovery" : "customer_notification_automatic",
          resourceType: "stop", resourceId: stop.id, method: "EVENT", path: "/customer-notifications",
          metadata: { attemptId: claim.id, revision: claim.revision, event, channel },
        });
        let status = "unknown";
        try {
          if (event === "approaching" && !(await liveSnapshot(stop)).key) {
            throw new Error("Destination no longer eligible");
          }
          if (channel === "sms" && await existingCustomerTrackingUrl(stop.id, organizationId) !== values.tracking_url) {
            throw new Error("Customer link changed");
          }
          const sent = channel === "sms"
            ? await transport.sendSms(recipient, linkedSmsMessage, organizationId)
            : await transport.sendEmail({to:recipient, idempotencyKey: `customer-${claim.id}-${claim.revision}`, subject:renderNotification(template.subject,values), html:`<div style="white-space:pre-wrap">${escapeNotificationHtml(renderNotification(template.email,values))}</div>`}, organizationId);
          status = typeof sent === "string" ? sent : sent ? "sent" : "unknown";
        } catch { status = "unknown"; }
        await db.update(customerNotificationAttemptsTable).set({status, updatedAt: new Date()}).where(and(
          eq(customerNotificationAttemptsTable.id, claim.id),
          eq(customerNotificationAttemptsTable.organizationId, organizationId),
          eq(customerNotificationAttemptsTable.revision, claim.revision),
        ));
        if (status === "sent" && event !== "planned") {
          await db.insert(deliveryNotificationsTable).values({
            stopId: stop.id, routeId, channel,
            type: event === "completed" ? "delivered" : "approaching",
            message: "Meddelandet accepterades av leverantören.",
          });
        }
        if (recovery) return true;
      }
    }
  } catch { logger.error({ event: "customer_notification_failed", routeId, organizationId }, "Customer notification did not complete"); }
  return undefined;
}

export async function recoverCustomerNotification(organizationId: string, recovery: Recovery, transport: Transport = customerTransport) {
  const [attempt] = await db.select().from(customerNotificationAttemptsTable).where(and(
    eq(customerNotificationAttemptsTable.id, recovery.id),
    eq(customerNotificationAttemptsTable.organizationId, organizationId),
  ));
  if (!attempt || !recoverableStatuses.includes(attempt.status) || attempt.revision !== recovery.revision) return false;
  if (!["planned", "approaching", "completed"].includes(attempt.event)) return false;
  // Legacy missing-recipient rows never touched the provider and are safe to
  // recover, but only if still present in this tenant's outgoing route.
  const [stop] = !attempt.routeId ? await db.select().from(stopsTable).where(and(
    eq(stopsTable.id, attempt.stopId), eq(stopsTable.organizationId, organizationId),
  )) : [];
  const routeId = attempt.routeId ?? stop?.routeId;
  if (!routeId) return false;
  return !!await notifyRouteCustomers(routeId, organizationId, attempt.event as Event, attempt.stopId, transport, recovery);
}
