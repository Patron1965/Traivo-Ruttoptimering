import { ReplitConnectors } from "@replit/connectors-sdk";
import { commonSmsConfiguration } from "./link-common-sms";
import { normalizePhone, configuredProvider } from "./sms";
import { loadOrganizationServicePolicy } from "./organization-service-policy";
import type { EmailPayload } from "./resend-email";

export type SubmissionOutcome = "sent" | "rejected" | "unknown";
// Only definitive request rejection permits a new submission. Timeouts, 5xx,
// malformed success bodies and unrecognised responses remain indeterminate.
export function rejectionOutcome(status: number): SubmissionOutcome {
  return [400, 401, 403, 422].includes(status) ? "rejected" : "unknown";
}
export const customerTransport = {
  configuredProvider,
  async sendEmail(payload: EmailPayload & { idempotencyKey?: string }, organizationId: string): Promise<SubmissionOutcome> {
    if (!(await loadOrganizationServicePolicy(organizationId)).emailEnabled) return "rejected";
    try {
      const result = await new ReplitConnectors().proxy("resend", "/emails", {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(payload.idempotencyKey ? { "Idempotency-Key": payload.idempotencyKey } : {}) },
        body: { from: "Traivo <noreply@traivo.se>", to: [payload.to], subject: payload.subject, html: payload.html },
      });
      return result.status >= 200 && result.status < 300 ? "sent" : rejectionOutcome(result.status);
    } catch { return "unknown"; }
  },
  async sendSms(to: string, message: string, organizationId: string): Promise<SubmissionOutcome> {
    if (!message.trim() || message.length > 459) return "rejected";
    const policy = await loadOrganizationServicePolicy(organizationId);
    if (configuredProvider(policy.smsProvider) !== "linkmobility") return "rejected";
    const recipient = normalizePhone(to);
    if (!/^\+[1-9]\d{7,14}$/.test(recipient)) return "rejected";
    const common = process.env.LINK_MOBILITY_API_VARIANT === "common";
    const configuration = common ? commonSmsConfiguration() : null;
    if (common && !configuration) return "rejected";
    try {
      const response = await fetch(configuration?.endpoint ?? "https://api.linkmobility.com/sms/v1/messages", {
        method: "POST", redirect: "error", signal: AbortSignal.timeout(15_000),
        headers: {
          "Content-Type": "application/json",
          Authorization: configuration
            ? `Basic ${Buffer.from(`${configuration.username}:${configuration.password}`).toString("base64")}`
            : `Bearer ${process.env.LINK_MOBILITY_API_TOKEN}`,
        },
        body: JSON.stringify(configuration ? {
          source: configuration.sender, sourceTON: "ALPHANUMERIC",
          destination: recipient, destinationTON: "MSISDN", userData: message.substring(0, 459), dcs: "TEXT",
          platformId: configuration.platformId, platformPartnerId: configuration.platformPartnerId,
          useDeliveryReport: true, deliveryReportGates: [configuration.gateId], ignoreResponse: false, tariff: 0,
        } : [{
          recipient, content: { text: message.substring(0, 459), options: {
            "sms.encoding": "AutoDetect", "sms.sender": process.env.LINK_MOBILITY_SENDER,
          } },
        }]),
      });
      // LINK can report per-message outcomes in a success body. Without a
      // verified rejection code contract, never authorize a repeat from it.
      if (!response.ok) return rejectionOutcome(response.status);
      if (!configuration) return "sent";
      const result = await response.json();
      return typeof result === "object" && result !== null && "resultCode" in result && result.resultCode === 1005
        && "messageId" in result && typeof result.messageId === "string" && result.messageId
        ? "sent" : "unknown";
    } catch { return "unknown"; }
  },
};
