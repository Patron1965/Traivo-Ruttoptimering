import { randomUUID } from "node:crypto";
import { pool, type PoolClient } from "@workspace/db";
import { logger } from "../lib/logger";
import { loadRuntimeState, saveRuntimeState } from "./planning-runtime-store";

const CHANNEL = "traivo_operational_events";
const senderId = randomUUID();
type RelayedEvent = { organizationId: string; type: string; payload: unknown };
let connected = false;

export function realtimeRelayConnected(): boolean { return connected; }

export async function publishRealtimeEvent(event: RelayedEvent): Promise<void> {
  const id = randomUUID();
  // NOTIFY is limited to 8KB. Carry only an opaque event reference; event
  // contents stay tenant-scoped in the database and expire after two minutes.
  await saveRuntimeState(event.organizationId, "realtime-event", id, event, 120_000);
  await pool.query("SELECT pg_notify($1, $2)", [
    CHANNEL, JSON.stringify({ senderId, id, organizationId: event.organizationId }),
  ]);
}

export function startRealtimeRelay(deliver: (event: RelayedEvent) => Promise<void>, localSenderId: string = senderId): () => void {
  let stopped = false;
  let client: PoolClient | null = null;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let disconnect: (() => void) | undefined;
  const reconnect = () => {
    if (stopped || retry) return;
    retry = setTimeout(() => { retry = undefined; void connect(); }, 2_000);
    retry.unref();
  };
  const connect = async () => {
    let acquired: PoolClient | null = null;
    let released = false;
    const retire = () => {
      if (released) return;
      released = true;
      connected = false;
      if (client === acquired) client = null;
      acquired?.release(true);
      reconnect();
    };
    try {
      acquired = await pool.connect();
      if (stopped) { acquired.release(); return; }
      client = acquired;
      disconnect = retire;
      acquired.on("notification", (message) => {
        if (message.channel !== CHANNEL || !message.payload) return;
        void (async () => {
          const reference = JSON.parse(message.payload!);
          if (reference.senderId === localSenderId) return;
          if (typeof reference.organizationId !== "string" || typeof reference.id !== "string") return;
          const stored = await loadRuntimeState<RelayedEvent>(reference.organizationId, "realtime-event", reference.id);
          if (stored && stored.value.organizationId === reference.organizationId) await deliver(stored.value);
        })().catch(() => logger.error({ event: "realtime_relay_delivery_failed" }, "Realtime relay delivery failed"));
      });
      acquired.once("error", retire);
      acquired.once("end", retire);
      await acquired.query(`LISTEN ${CHANNEL}`);
      if (stopped) retire();
      else connected = true;
    } catch {
      retire();
      logger.error({ event: "realtime_relay_disconnected" }, "Realtime relay unavailable; reconnect scheduled");
      reconnect();
    }
  };
  void connect();
  return () => {
    stopped = true;
    connected = false;
    if (retry) clearTimeout(retry);
    const current = client;
    client = null;
    if (current) void current.query(`UNLISTEN ${CHANNEL}`).finally(() => disconnect?.()).catch(() => {});
  };
}
