import { ReplitConnectors } from "@replit/connectors-sdk";
import { assertOrganizationServiceEnabled } from "./organization-service-policy";
import { getUsageContext } from "./usage-context";
export interface EmailPayload { to: string; toName?: string; subject: string; html: string }
export interface RecoveryEmailResult {
  outcome: "accepted" | "rejected" | "timeout" | "unknown";
  providerId?: string;
  httpStatus?: number;
}
export const isResendId = (value: unknown): value is string =>
  typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

/** Bound waiting, never retry: a lost response may still represent a sent email. */
export async function boundedEmailRequest<T>(work: () => Promise<T>, fallback: T, milliseconds = 15_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([work(), new Promise<T>(resolve => {
      timer = setTimeout(() => resolve(fallback), milliseconds);
    })]);
  } finally { clearTimeout(timer); }
}
export async function sendRecoveryEmailDetailed(payload: EmailPayload): Promise<RecoveryEmailResult> {
  return boundedEmailRequest<RecoveryEmailResult>(async () => {
    try {
      const response = await new ReplitConnectors().proxy("resend", "/emails", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: { from: "Traivo <noreply@traivo.se>", to: [payload.to], subject: payload.subject, html: payload.html },
      });
      // Do not retain provider error prose, headers, or response bodies.
      if (!response.ok) return {
        outcome: response.status >= 400 && response.status < 500 && response.status !== 408 ? "rejected" : "unknown",
        httpStatus: response.status,
      };
      const body = await response.json().catch(() => null) as { id?: unknown } | null;
      return { outcome: "accepted", httpStatus: response.status,
        ...(isResendId(body?.id) ? { providerId: body.id } : {}) };
    } catch { return { outcome: "unknown" }; }
  }, { outcome: "timeout" });
}

export type RecoveryDeliveryOutcome = "delivered" | "bounced" | "complained" | "delivery_delayed" | "failed" | "unconfirmed" | "unavailable";
export async function checkRecoveryEmailDelivery(providerId: string): Promise<RecoveryDeliveryOutcome> {
  if (!isResendId(providerId)) return "unavailable";
  return boundedEmailRequest<RecoveryDeliveryOutcome>(async () => {
    try {
      const response = await new ReplitConnectors().proxy("resend", `/emails/${providerId}`, { method: "GET" });
      if (!response.ok) return "unavailable";
      const body = await response.json() as { id?: unknown; last_event?: unknown } | null;
      if (body?.id !== providerId) return "unavailable";
      // 'sent' means accepted by Resend, NOT delivered to the recipient's server.
      return typeof body.last_event === "string" && ["delivered", "bounced", "complained", "delivery_delayed", "failed"].includes(body.last_event)
        ? body.last_event as RecoveryDeliveryOutcome : "unconfirmed";
    } catch { return "unavailable"; }
  }, "unavailable");
}
export async function sendRecoveryEmail(payload: EmailPayload): Promise<boolean> {
  try {
    const result = await new ReplitConnectors().proxy("resend", "/emails", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: { from: "Traivo <noreply@traivo.se>", to: [payload.to], subject: payload.subject, html: payload.html },
    });
    return result.status >= 200 && result.status < 300;
  } catch { return false; }
}
export async function sendEmail(payload: EmailPayload, organizationId = getUsageContext()?.organizationId) {
  await assertOrganizationServiceEnabled("emailEnabled", organizationId);
  return sendRecoveryEmail(payload);
}
