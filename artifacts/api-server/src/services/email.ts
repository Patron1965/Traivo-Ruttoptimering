import { db, deliveryNotificationsTable, stopsTable } from "@workspace/db";
import { eq } from "drizzle-orm";

interface EmailPayload {
  to: string;
  toName: string;
  subject: string;
  html: string;
}

async function sendEmail(payload: EmailPayload): Promise<boolean> {
  console.log(`[EMAIL] To: ${payload.to} (${payload.toName})`);
  console.log(`[EMAIL] Subject: ${payload.subject}`);
  console.log(`[EMAIL] Body: ${payload.html.substring(0, 200)}...`);
  return true;
}

function getTrackingUrl(trackingCode: string): string {
  const domain = process.env.REPLIT_DEV_DOMAIN || "localhost";
  return `https://${domain}/track/${trackingCode}`;
}

function formatEta(etaMin: number | null): string {
  if (!etaMin || etaMin <= 0) return "";
  if (etaMin < 60) return `~${etaMin} min`;
  const hours = Math.floor(etaMin / 60);
  const mins = etaMin % 60;
  return mins > 0 ? `~${hours}h ${mins}min` : `~${hours}h`;
}

export async function sendApproachingNotification(
  stopId: string,
  routeId: string | null,
  vehicleName: string,
  etaMinutes: number | null,
): Promise<void> {
  const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
  if (!stop?.contactEmail) return;

  const trackingUrl = stop.trackingCode ? getTrackingUrl(stop.trackingCode) : null;
  const eta = formatEta(etaMinutes);
  const name = stop.contactName || "Kund";

  const subject = `Din leverans är snart framme${eta ? ` (${eta})` : ""}`;
  const html = `
    <div style="font-family: sans-serif; max-width: 500px;">
      <h2>Hej ${name}!</h2>
      <p><strong>${vehicleName}</strong> är på väg till <strong>${stop.address}</strong>${eta ? ` och beräknas vara framme om <strong>${eta}</strong>` : ""}.</p>
      ${trackingUrl ? `<p><a href="${trackingUrl}" style="display:inline-block;padding:12px 24px;background:#0ea5e9;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Följ leveransen live</a></p>` : ""}
      <p style="color:#666;font-size:13px;">Du kan se live-status och beräknad ankomsttid via länken ovan.</p>
    </div>
  `;

  await sendEmail({ to: stop.contactEmail, toName: name, subject, html });

  await db.insert(deliveryNotificationsTable).values({
    stopId,
    routeId,
    type: "approaching",
    channel: "email",
    message: `Approaching notification sent to ${stop.contactEmail}${eta ? ` (ETA: ${eta})` : ""}`,
  });
}

export async function sendDeliveredNotification(
  stopId: string,
  routeId: string | null,
  vehicleName: string,
): Promise<void> {
  const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
  if (!stop?.contactEmail) return;

  const trackingUrl = stop.trackingCode ? getTrackingUrl(stop.trackingCode) : null;
  const name = stop.contactName || "Kund";

  const subject = "Din leverans har anlänt!";
  const html = `
    <div style="font-family: sans-serif; max-width: 500px;">
      <h2>Hej ${name}!</h2>
      <p>Din leverans till <strong>${stop.address}</strong> har levererats av <strong>${vehicleName}</strong>.</p>
      ${trackingUrl ? `<p><a href="${trackingUrl}" style="display:inline-block;padding:12px 24px;background:#10b981;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Se leveransbevis</a></p>` : ""}
      <p style="color:#666;font-size:13px;">Tack för att du valde oss!</p>
    </div>
  `;

  await sendEmail({ to: stop.contactEmail, toName: name, subject, html });

  await db.insert(deliveryNotificationsTable).values({
    stopId,
    routeId,
    type: "delivered",
    channel: "email",
    message: `Delivered notification sent to ${stop.contactEmail}`,
  });
}

export async function sendFailedNotification(
  stopId: string,
  routeId: string | null,
  vehicleName: string,
  reason?: string,
): Promise<void> {
  const [stop] = await db.select().from(stopsTable).where(eq(stopsTable.id, stopId));
  if (!stop?.contactEmail) return;

  const trackingUrl = stop.trackingCode ? getTrackingUrl(stop.trackingCode) : null;
  const name = stop.contactName || "Kund";

  const subject = "Problem med din leverans";
  const html = `
    <div style="font-family: sans-serif; max-width: 500px;">
      <h2>Hej ${name}!</h2>
      <p>Vi kunde tyvärr inte genomföra leveransen till <strong>${stop.address}</strong>.</p>
      ${reason ? `<p>Orsak: ${reason}</p>` : ""}
      <p>Vi kommer att försöka igen så snart som möjligt. Du kan följa statusen via länken nedan.</p>
      ${trackingUrl ? `<p><a href="${trackingUrl}" style="display:inline-block;padding:12px 24px;background:#ef4444;color:#fff;text-decoration:none;border-radius:8px;font-weight:bold;">Följ leveransen</a></p>` : ""}
    </div>
  `;

  await sendEmail({ to: stop.contactEmail, toName: name, subject, html });

  await db.insert(deliveryNotificationsTable).values({
    stopId,
    routeId,
    type: "failed",
    channel: "email",
    message: `Failed notification sent to ${stop.contactEmail}${reason ? ` (reason: ${reason})` : ""}`,
  });
}
