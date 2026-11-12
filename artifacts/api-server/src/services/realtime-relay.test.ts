import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, test } from "node:test";
import { eq } from "drizzle-orm";
import { db, pool, organizationsTable } from "@workspace/db";
import { publishRealtimeEvent, realtimeRelayConnected, startRealtimeRelay } from "./realtime-relay";

after(async () => { await pool.end(); });

test("separate PostgreSQL connections deliver a large tenant event via an opaque reference", async () => {
  const organizationId = randomUUID();
  await db.insert(organizationsTable).values({ id: organizationId, name: "Synthetic relay", email: "relay@example.test" });
  let stop = () => {};
  try {
    let received: unknown;
    const delivered = new Promise<void>(resolve => {
      stop = startRealtimeRelay(async event => { received = event; resolve(); }, "separate-instance");
    });
    const until = Date.now() + 5000;
    while (!realtimeRelayConnected() && Date.now() < until) await new Promise(r => setTimeout(r, 10));
    assert.equal(realtimeRelayConnected(), true);
    const event = { organizationId, type: "route:updated", payload: { message: "synthetic".repeat(2000) } };
    await publishRealtimeEvent(event);
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([delivered, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("relay timeout")), 5000); })]);
    } finally { clearTimeout(timer); }
    assert.deepEqual(received, event);
  } finally {
    stop();
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});
