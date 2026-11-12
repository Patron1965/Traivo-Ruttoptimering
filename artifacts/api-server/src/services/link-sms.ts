export interface LinkSmsMessage {
  source: string;
  destination: string;
  userData: string;
}

export function isLinkSmsConfigured(): boolean {
  return ["LINK_USERNAME", "LINK_PASSWORD", "LINK_PLATFORM_ID", "LINK_PLATFORM_PARTNER_ID", "LINK_GATE_ID"]
    .every((key) => Boolean(process.env[key]?.trim()));
}

export function isValidLinkSender(source: string): boolean {
  return /^[A-Za-z][A-Za-z0-9]{1,10}$/.test(source);
}

export function isAutomaticLinkSmsConfigured(): boolean {
  return isLinkSmsConfigured() && isValidLinkSender(process.env.LINK_MOBILITY_SENDER ?? "");
}

export function isValidLinkSms(message: LinkSmsMessage): boolean {
  return isValidLinkSender(message.source) &&
    /^\+467[0-9]{8}$/.test(message.destination) &&
    message.userData.trim().length > 0 &&
    message.userData.length <= 459;
}

/** No retries: a timed-out request may already have been accepted by LINK. */
export async function sendLinkSms(message: LinkSmsMessage): Promise<boolean> {
  if (!isLinkSmsConfigured() || !isValidLinkSms(message)) return false;
  try {
    const response = await fetch("https://n-eu.linkmobility.io/sms/send", {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Basic ${Buffer.from(
          `${process.env.LINK_USERNAME}:${process.env.LINK_PASSWORD}`,
        ).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...message,
        sourceTON: "ALPHANUMERIC",
        platformId: process.env.LINK_PLATFORM_ID,
        platformPartnerId: process.env.LINK_PLATFORM_PARTNER_ID,
        useDeliveryReport: true,
        deliveryReportGates: [process.env.LINK_GATE_ID],
      }),
    });
    // Never log provider responses: they may echo credentials or recipients.
    return response.ok;
  } catch {
    return false;
  }
}
