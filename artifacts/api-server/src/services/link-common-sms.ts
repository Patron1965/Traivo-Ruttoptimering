import { logger } from "../lib/logger";

const allowedHosts = new Set([
  "eu.linkmobility.io", "n-eu.linkmobility.io",
  "c-eu.linkmobility.io", "s-eu.linkmobility.io",
]);

export function commonSmsConfiguration() {
  const { LINK_USERNAME: username, LINK_PASSWORD: password,
    LINK_PLATFORM_ID: platformId, LINK_PLATFORM_PARTNER_ID: platformPartnerId,
    LINK_MOBILITY_SENDER: sender, LINK_MOBILITY_BASE_URL: baseUrl,
    LINK_GATE_ID: gateId } = process.env;
  if (![username, password, platformId, platformPartnerId, sender, baseUrl, gateId].every(value => value?.trim())) return null;
  if (!/^[A-Za-z][A-Za-z0-9]{1,10}$/.test(sender!)) return null;
  try {
    const url = new URL(baseUrl!);
    if (url.protocol !== "https:" || !allowedHosts.has(url.hostname) ||
      url.port || url.username || url.password || url.search || url.hash ||
      !/^\/sms\/?$/.test(url.pathname)) return null;
    return { username: username!, password: password!, platformId: platformId!,
      platformPartnerId: platformPartnerId!, sender: sender!, gateId: gateId!,
      endpoint: `${url.origin}/sms/send` };
  } catch {
    return null;
  }
}

/** Common/CGI REST contract; never infer platform IDs from service/gate IDs. */
export async function sendCommonSms(to: string, message: string): Promise<boolean> {
  const configuration = commonSmsConfiguration();
  if (!configuration || !/^\+[1-9]\d{7,14}$/.test(to)) return false;
  try {
    const response = await fetch(configuration.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Authorization: `Basic ${Buffer.from(`${configuration.username}:${configuration.password}`).toString("base64")}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        source: configuration.sender, sourceTON: "ALPHANUMERIC",
        destination: to, destinationTON: "MSISDN",
        userData: message, dcs: "TEXT",
        platformId: configuration.platformId,
        platformPartnerId: configuration.platformPartnerId,
        useDeliveryReport: true, deliveryReportGates: [configuration.gateId], ignoreResponse: false, tariff: 0,
      }),
    });
    if (response.status !== 200) {
      logger.warn({ status: response.status }, "LINK Common rejected SMS submission");
      return false;
    }
    const result: unknown = await response.json();
    const accepted = typeof result === "object" && result !== null &&
      "resultCode" in result && result.resultCode === 1005 &&
      "messageId" in result && typeof result.messageId === "string" && result.messageId.length > 0;
    // Submission acceptance is not a handset delivery receipt.
    if (accepted) logger.info({}, "LINK Common accepted SMS submission; delivery unconfirmed");
    else logger.warn({}, "LINK Common did not confirm SMS submission");
    return accepted;
  } catch {
    // Never log errors containing request bodies, credentials or recipients.
    logger.warn({}, "LINK Common SMS submission failed; not automatically retried");
    return false;
  }
}
