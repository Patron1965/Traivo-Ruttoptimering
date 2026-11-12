import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, stopsTable, customerLinksTable, customerNotificationAttemptsTable, auditLogTable } from "@workspace/db";
import { CustomerLinkError, customerLinkState } from "./customer-links";
import { customerTransport } from "./customer-notification-transport";
import { loadOrganizationServicePolicy } from "./organization-service-policy";
import { normalizePhone } from "./sms";

const attempts = customerNotificationAttemptsTable;
const scope = (stopId: string, organizationId: string) => and(
  eq(attempts.organizationId, organizationId), eq(attempts.stopId, stopId),
  eq(attempts.event, "approaching"), eq(attempts.channel, "sms"),
);
export function smsAttemptStatus(attempt?: typeof attempts.$inferSelect) {
  if (!attempt) return "none";
  if (attempt.status === "sending" && Date.now() - attempt.updatedAt.getTime() > 60_000) return "unknown";
  return attempt.status;
}
export async function customerSmsPreview(stopId: string, organizationId: string, transport = customerTransport) {
  const policy = await loadOrganizationServicePolicy(organizationId);
  return db.transaction(async tx => {
    const [stop] = await tx.select().from(stopsTable).where(and(eq(stopsTable.id, stopId), eq(stopsTable.organizationId, organizationId))).for("update");
    if (!stop) throw new CustomerLinkError("STOP_NOT_FOUND", 404, "Leveransen finns inte.");
    const [link] = await tx.select().from(customerLinksTable).where(eq(customerLinksTable.stopId, stopId));
    const [attempt] = await tx.select().from(attempts).where(scope(stopId, organizationId));
    const url = customerLinkState(stop, link, new Date()).url;
    const recipient = normalizePhone(stop.contactPhone ?? "");
    const message = url ? `Följ din leverans här: ${url}` : "";
    const blockedReason = !recipient ? "Telefonnummer saknas på leveransen."
      : !/^\+[1-9]\d{7,14}$/.test(recipient) ? "Telefonnumret är ogiltigt. Ange landskod eller ett svenskt nummer."
      : transport.configuredProvider(policy.smsProvider) !== "linkmobility" ? "SMS via LINK Mobility är inte tillgängligt för organisationen."
      : !url ? "Skapa eller ersätt kundlänken uttryckligen innan du skickar SMS."
      : message.length > 459 ? "Kundlänken är för lång för SMS." : null;
    const revision = attempt?.revision ?? -1;
    // No link, message or phone is persisted in the claim/audit log.
    const confirmation = createHash("sha256").update(JSON.stringify([stopId, organizationId, recipient, message, revision])).digest("hex");
    return { recipient, message, blockedReason, revision, confirmation, status: smsAttemptStatus(attempt) };
  });
}

export async function sendCustomerLinkSms(stopId: string, organizationId: string, actorId: string,
  input: { revision: number; confirmation: string; resend: boolean }, transport = customerTransport) {
  const preview = await customerSmsPreview(stopId, organizationId, transport);
  // A lost response, concurrent submit or double-click never authorizes another send.
  if (preview.revision !== input.revision) return preview;
  if (preview.blockedReason) throw new CustomerLinkError("SMS_UNAVAILABLE", 409, preview.blockedReason);
  if (input.confirmation !== preview.confirmation) throw new CustomerLinkError("SMS_PREVIEW_CHANGED", 409, "Mottagare eller kundlänk har ändrats. Öppna förhandsvisningen igen.");
  if (preview.revision >= 0 && !input.resend) throw new CustomerLinkError("SMS_RESEND_REQUIRED", 409, "Välj uttryckligen Skicka igen.");
  if (preview.status === "sending") throw new CustomerLinkError("SMS_IN_PROGRESS", 409, "Ett utskick pågår redan.");
  const claim = await db.transaction(async tx => {
    const [stop] = await tx.select().from(stopsTable).where(and(eq(stopsTable.id, stopId), eq(stopsTable.organizationId, organizationId))).for("update");
    if (!stop) throw new CustomerLinkError("STOP_NOT_FOUND", 404, "Leveransen finns inte.");
    const [link] = await tx.select().from(customerLinksTable).where(eq(customerLinksTable.stopId, stopId));
    const url = customerLinkState(stop, link, new Date()).url;
    if (!url || `Följ din leverans här: ${url}` !== preview.message || normalizePhone(stop.contactPhone ?? "") !== preview.recipient)
      throw new CustomerLinkError("SMS_PREVIEW_CHANGED", 409, "Mottagare eller kundlänk har ändrats. Öppna förhandsvisningen igen.");
    const [previous] = await tx.select().from(attempts).where(scope(stopId, organizationId));
    if ((previous?.revision ?? -1) !== input.revision) return null;
    const now = new Date();
    const [row] = previous
      ? await tx.update(attempts).set({ status: "sending", revision: previous.revision + 1, routeId: stop.routeId, updatedAt: now,
        history: [...previous.history, { status: previous.status, at: now.toISOString(), actorId }] })
        .where(and(scope(stopId, organizationId), eq(attempts.revision, input.revision), eq(attempts.status, previous.status))).returning()
      : await tx.insert(attempts).values({ organizationId, stopId, routeId: stop.routeId, event: "approaching", channel: "sms", status: "sending",
        history: [{ status: "manual", at: now.toISOString(), actorId }] }).onConflictDoNothing().returning();
    if (row) await tx.insert(auditLogTable).values({
      organizationId, userId: actorId, action: previous ? "customer_sms_resend" : "customer_sms_send",
      resourceType: "stop", resourceId: stopId, method: "POST", path: "/stops/:id/customer-link/sms",
      metadata: { attemptId: row.id, revision: row.revision, source: "operator" },
    });
    return row;
  });
  if (claim) {
    let status: "sent" | "rejected" | "unknown" = "unknown";
    try { status = await transport.sendSms(preview.recipient, preview.message, organizationId); } catch { /* uncertain: never retry */ }
    await db.update(attempts).set({ status, updatedAt: new Date() })
      .where(and(eq(attempts.id, claim.id), eq(attempts.revision, claim.revision)));
  }
  return customerSmsPreview(stopId, organizationId, transport);
}
