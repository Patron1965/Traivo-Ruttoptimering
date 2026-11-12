import { currentOrganizationServicePolicy, loadOrganizationServicePolicy, OrganizationServicePolicyError } from "./organization-service-policy";
import { getUsageContext } from "./usage-context";
import { commonSmsConfiguration, sendCommonSms } from "./link-common-sms";
import { isAutomaticLinkSmsConfigured, sendLinkSms } from "./link-sms";

interface SmsPayload {
  to: string;
  message: string;
}

type SmsProvider = "linkmobility" | "twilio" | "46elks";

export function normalizePhone(phone: string): string {
  const trimmed = phone.replace(/[\s\-()]/g, "");
  if (trimmed.startsWith("+")) return trimmed;
  if (trimmed.startsWith("00")) return "+" + trimmed.slice(2);
  if (trimmed.startsWith("0")) return "+46" + trimmed.slice(1);
  return trimmed;
}

export function configuredProvider(selection = currentOrganizationServicePolicy().smsProvider): SmsProvider | null {
  if (selection === "disabled") return null;
  const selected = selection === "inherit" ? process.env.SMS_PROVIDER?.trim().toLowerCase() : selection;
  if (selected === "linkmobility") {
    if (process.env.LINK_MOBILITY_API_VARIANT === "common") {
      return commonSmsConfiguration() ? "linkmobility" : null;
    }
    return isAutomaticLinkSmsConfigured()
      ? "linkmobility"
      : null;
  }
  if (selected === "twilio") {
    return process.env.TWILIO_ACCOUNT_SID &&
      process.env.TWILIO_AUTH_TOKEN &&
      process.env.TWILIO_FROM_NUMBER
      ? "twilio"
      : null;
  }
  if (selected === "46elks") {
    return process.env.ELKS_API_USERNAME && process.env.ELKS_API_PASSWORD
      ? "46elks"
      : null;
  }
  if (selected) return null;

  if (
    process.env.TWILIO_ACCOUNT_SID &&
    process.env.TWILIO_AUTH_TOKEN &&
    process.env.TWILIO_FROM_NUMBER
  ) return "twilio";
  if (process.env.ELKS_API_USERNAME && process.env.ELKS_API_PASSWORD) return "46elks";
  return null;
}

async function sendViaLinkMobility(payload: SmsPayload): Promise<boolean> {
  if (process.env.LINK_MOBILITY_API_VARIANT === "common") {
    return sendCommonSms(payload.to, payload.message);
  }
  return sendLinkSms({
    source: process.env.LINK_MOBILITY_SENDER ?? "",
    destination: payload.to,
    userData: payload.message,
  });
}

async function sendViaTwilio(payload: SmsPayload): Promise<boolean> {
  const TWILIO_SID = process.env.TWILIO_ACCOUNT_SID;
  const TWILIO_TOKEN = process.env.TWILIO_AUTH_TOKEN;
  const TWILIO_FROM = process.env.TWILIO_FROM_NUMBER;
  if (!TWILIO_SID || !TWILIO_TOKEN || !TWILIO_FROM) return false;
  try {
    const auth = Buffer.from(`${TWILIO_SID}:${TWILIO_TOKEN}`).toString("base64");
    const body = new URLSearchParams({
      To: payload.to,
      From: TWILIO_FROM,
      Body: payload.message,
    });
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${TWILIO_SID}/Messages.json`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      console.error(`[SMS] Twilio error ${res.status}`);
      return false;
    }
    console.log("[SMS] Submission accepted by Twilio");
    return true;
  } catch (err) {
    console.error("[SMS] Twilio failed");
    return false;
  }
}

async function sendViaElks(payload: SmsPayload): Promise<boolean> {
  const ELKS_USER = process.env.ELKS_API_USERNAME;
  const ELKS_PASS = process.env.ELKS_API_PASSWORD;
  const ELKS_FROM = process.env.ELKS_FROM_NUMBER || "Traivo";
  if (!ELKS_USER || !ELKS_PASS) return false;
  try {
    const auth = Buffer.from(`${ELKS_USER}:${ELKS_PASS}`).toString("base64");
    const body = new URLSearchParams({
      from: ELKS_FROM,
      to: payload.to,
      message: payload.message,
    });
    const res = await fetch("https://api.46elks.com/a1/sms", {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    if (!res.ok) {
      console.error(`[SMS] 46elks error ${res.status}`);
      return false;
    }
    console.log("[SMS] Submission accepted by 46elks");
    return true;
  } catch (err) {
    console.error("[SMS] 46elks failed");
    return false;
  }
}

export async function sendSms(to: string, message: string, organizationId = getUsageContext()?.organizationId): Promise<boolean> {
  const policy = organizationId ? await loadOrganizationServicePolicy(organizationId) : currentOrganizationServicePolicy();
  if (policy.smsProvider === "disabled") throw new OrganizationServicePolicyError();
  if (!to) return false;
  const normalized = normalizePhone(to);
  const payload = { to: normalized, message: message.substring(0, 459) };

  switch (configuredProvider(policy.smsProvider)) {
    case "linkmobility":
      return sendViaLinkMobility(payload);
    case "twilio":
      return sendViaTwilio(payload);
    case "46elks":
      return sendViaElks(payload);
    default:
      console.log("[SMS] No provider configured; message not sent");
      return false;
  }
}

export function isSmsConfigured(): boolean {
  return configuredProvider() !== null;
}
