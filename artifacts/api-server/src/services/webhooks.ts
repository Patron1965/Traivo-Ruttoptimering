import crypto from "crypto";
import { db, webhooksTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";

export interface WebhookPayload {
  event: string;
  timestamp: string;
  organizationId: string;
  data: Record<string, unknown>;
}

function signPayload(payload: string, secret: string): string {
  return crypto.createHmac("sha256", secret).update(payload).digest("hex");
}

async function deliverToHook(
  hook: { url: string; name: string; secret: string | null },
  event: string,
  body: string,
  timestamp: string,
): Promise<void> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "X-RouteAI-Event": event,
    "X-RouteAI-Timestamp": timestamp,
  };

  if (hook.secret) {
    headers["X-RouteAI-Signature"] = signPayload(body, hook.secret);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10000);

  try {
    const res = await fetch(hook.url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });

    clearTimeout(timeout);

    if (!res.ok) {
      console.warn(`[WEBHOOK] ${hook.name} (${hook.url}) returned ${res.status}`);
    } else {
      console.log(`[WEBHOOK] ${hook.name} -> ${event} dispatched (${res.status})`);
    }
  } catch (err: any) {
    clearTimeout(timeout);
    console.error(`[WEBHOOK] ${hook.name} (${hook.url}) failed:`, err.message);
  }
}

export async function dispatchWebhookEvent(
  organizationId: string,
  event: string,
  data: Record<string, unknown>,
): Promise<void> {
  const hooks = await db
    .select()
    .from(webhooksTable)
    .where(and(eq(webhooksTable.organizationId, organizationId), eq(webhooksTable.active, true)));

  const matching = hooks.filter((h) => {
    if (h.events === "*") return true;
    const events = h.events.split(",").map((e) => e.trim());
    return events.includes(event);
  });

  if (matching.length === 0) return;

  const payload: WebhookPayload = {
    event,
    timestamp: new Date().toISOString(),
    organizationId,
    data,
  };

  const body = JSON.stringify(payload);

  await Promise.allSettled(
    matching.map((hook) => deliverToHook(hook, event, body, payload.timestamp)),
  );
}

export async function dispatchTestToSingleHook(
  hook: { url: string; name: string; secret: string | null; organizationId: string },
): Promise<void> {
  const payload: WebhookPayload = {
    event: "webhook.test",
    timestamp: new Date().toISOString(),
    organizationId: hook.organizationId,
    data: {
      message: "This is a test webhook from RouteAI",
    },
  };

  const body = JSON.stringify(payload);
  await deliverToHook(hook, "webhook.test", body, payload.timestamp);
}
