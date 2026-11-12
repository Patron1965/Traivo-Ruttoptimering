import assert from "node:assert/strict";
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { once } from "node:events";
import { test } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { installDatabaseConnectionErrorHandlers } from "../src/lib/database-connection-errors";

async function eventually(predicate: () => boolean, label: string) {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (predicate()) return;
    await delay(10);
  }
  assert.fail(`Timed out: ${label}`);
}

test("real TCP loss preserves process, query failure, atomicity and recovery", { timeout: 30_000 }, async (t) => {
  const socketPath = process.env.DISCONNECT_TEST_SOCKET;
  assert.ok(socketPath && /\/\.cache\/db-disconnect\.[^/]+\/socket\/\.s\.PGSQL\.5432$/.test(socketPath),
    "Run scripts/test-database-disconnect.sh; an isolated cluster is mandatory");
  assert.equal(process.env.DATABASE_URL, undefined, "Never accept an existing database URL");

  const connections = new Set<{ front: Socket; back: Socket }>();
  let acceptedConnections = 0;
  const proxy = createServer((front) => {
    acceptedConnections++;
    const back = connect(socketPath);
    const pair = { front, back };
    connections.add(pair);
    front.on("error", () => back.destroy());
    back.on("error", () => front.destroy());
    front.on("close", () => { back.destroy(); connections.delete(pair); });
    back.on("close", () => front.destroy());
    front.pipe(back).pipe(front);
  });
  proxy.listen(0, "127.0.0.1");
  await once(proxy, "listening");
  t.after(async () => {
    for (const pair of connections) { pair.front.destroy(); pair.back.destroy(); }
    await new Promise<void>((resolve) => proxy.close(() => resolve()));
  });
  const address = proxy.address();
  assert.ok(address && typeof address !== "string");
  process.env.DATABASE_URL = `postgresql://disconnect_test@127.0.0.1:${address.port}/postgres?sslmode=disable`;
  // Actual shared pool, including observeClientErrors, not a mocked pg client.
  const { pool } = await import("@workspace/db");
  t.after(async () => { await pool.end(); delete process.env.DATABASE_URL; });
  let reports = 0;
  installDatabaseConnectionErrorHandlers(pool, () => { reports++; });

  // Deliberately omit index.ts's seeding, workers and external integrations.
  // HTTP requests prove this isolated API-host process remains responsive.
  const http = createHttpServer((_req, res) => { res.end("alive"); });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => new Promise<void>((resolve) => http.close(() => resolve())));
  const httpAddress = http.address();
  assert.ok(httpAddress && typeof httpAddress !== "string");
  const assertAlive = async () => {
    const response = await fetch(`http://127.0.0.1:${httpAddress.port}`);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), "alive");
  };
  const cut = () => {
    assert.equal(connections.size, 1, "Only this test's single connection may be interrupted");
    for (const pair of connections) { pair.front.destroy(); pair.back.destroy(); }
  };
  const pid = async () => Number((await pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid);
  await pool.query("CREATE TABLE effects (label text NOT NULL)");
  await pool.query("CREATE SEQUENCE write_attempts");

  await t.test("idle pool socket is evicted and replaced without killing HTTP", async () => {
    const before = await pid();
    const reportedBefore = reports;
    cut();
    await eventually(() => reports > reportedBefore && pool.totalCount === 0, "idle error and eviction");
    assert.equal(reports, reportedBefore + 1, "forwarded idle error is deduplicated");
    await assertAlive();
    assert.notEqual(await pid(), before);
  });

  await t.test("checked-out socket between statements cannot commit partial writes", async () => {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO effects VALUES ('partial')");
      const reportedBefore = reports;
      cut();
      await eventually(() => reports > reportedBefore, "checked-out connection error");
      await assert.rejects(client.query("COMMIT"), /connection|queryable/i);
      await assertAlive();
    } finally {
      client.release(true);
    }
    assert.deepEqual((await pool.query("SELECT label FROM effects")).rows, []);
  });

  await t.test("in-flight write rejects once, rolls back and is never replayed", async () => {
    const client = await pool.connect();
    const attemptsBefore = acceptedConnections;
    try {
      await client.query("BEGIN");
      await client.query("INSERT INTO effects VALUES ('first')");
      // Sequence increments survive rollback, detecting even rolled-back replay.
      // The notice synchronizes the cut after the INSERT and before completion.
      const entered = once(client, "notice");
      const pending = client.query(`DO $$
        BEGIN
          PERFORM nextval('write_attempts');
          INSERT INTO effects VALUES ('second');
          RAISE NOTICE 'disconnect_ready';
          PERFORM pg_sleep(10);
        END $$`);
      // Attach the rejection handler before cutting the transport.
      const rejected = assert.rejects(pending, /connection|terminated|closed/i);
      await entered;
      cut();
      await rejected;
      await assertAlive();
      await delay(100);
      assert.equal(acceptedConnections, attemptsBefore, "No automatic reconnection/replay");
      await assert.rejects(client.query("COMMIT"), /connection|queryable/i);
    } finally {
      client.release(true);
    }
    assert.deepEqual((await pool.query("SELECT label FROM effects")).rows, []);
    assert.equal(Number((await pool.query("SELECT last_value FROM write_attempts")).rows[0].last_value), 1);
    await pool.query("BEGIN; INSERT INTO effects VALUES ('recovered'); COMMIT");
    assert.deepEqual((await pool.query("SELECT label FROM effects")).rows, [{ label: "recovered" }]);
    await assertAlive();
  });
});
