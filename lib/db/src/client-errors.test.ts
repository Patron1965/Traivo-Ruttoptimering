import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { observeClientErrors } from "./client-errors";

// Real pg Client error/query and pg-pool checkout/release machinery; only the
// socket handshake is stubbed. No database or provider connection is made.
class SocketlessClient extends pg.Client {
  connect(): Promise<pg.Client>;
  connect(callback: ((error: Error) => void) | ((error: null, client: pg.Client) => void)): void;
  connect(callback?: ((error: Error) => void) | ((error: null, client: pg.Client) => void)): Promise<pg.Client> | void {
    if (!callback) return Promise.resolve(this);
    // The stub only models successful handshakes; failures are emitted later.
    const onConnected = callback as (error: null, client: pg.Client) => void;
    queueMicrotask(() => onConnected(null, this));
  }
  end(callback?: (error?: Error) => void): any {
    queueMicrotask(() => {
      this.emit("end");
      callback?.();
    });
    return Promise.resolve();
  }
}

test("checked-out fatal errors cannot crash, write or commit; release evicts client", async () => {
  const pool = new pg.Pool({ Client: SocketlessClient, max: 1 } as any);
  observeClientErrors(pool);
  try {
    const client = await pool.connect();
    assert.equal(pool.idleCount, 0);
    const failure = Object.assign(new Error("idle-in-transaction timeout"), { code: "25P03" });
    // The actual handler used by pg for a server error without an active query.
    assert.doesNotThrow(() => (client as any)._handleErrorEvent(failure));
    for (const statement of ["INSERT INTO test VALUES (1)", "COMMIT", "ROLLBACK"]) {
      await assert.rejects(client.query(statement), /not queryable/);
    }
    client.release();
    assert.equal(pool.totalCount, 0);
    const replacement = await pool.connect();
    assert.notEqual(replacement, client);
    replacement.release();
    assert.equal(pool.idleCount, 1);
  } finally {
    await pool.end();
  }
});

test("idle pool error is observed and evicts the failed client too", async () => {
  const pool = new pg.Pool({ Client: SocketlessClient, max: 1 } as any);
  observeClientErrors(pool);
  try {
    const client = await pool.connect();
    client.release();
    assert.doesNotThrow(() => (client as any)._handleErrorEvent(new Error("connection lost")));
    assert.equal(pool.totalCount, 0);
  } finally {
    await pool.end();
  }
});

test("development PostgreSQL idle transaction timeout rejects commit and releases a broken checkout", {
  skip: process.env.RUN_LOCAL_PG_TIMEOUT_TEST !== "1",
  timeout: 10_000,
}, async () => {
  assert.notEqual(process.env.REPLIT_DEPLOYMENT, "1");
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
  observeClientErrors(pool);
  let client: pg.PoolClient | undefined;
  try {
    const identity = await pool.query(
      "SELECT current_database() AS database, inet_server_addr()::text AS address, oid AS database_oid FROM pg_database WHERE datname=current_database()",
    );
    assert.deepEqual(identity.rows, [{ database: "heliumdb", address: null, database_oid: 16384 }],
      "This opt-in destructive-connection test only permits the verified local development database");
    client = await pool.connect();
    const originalPid = (await client.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    const failed = new Promise<Error & { code?: string }>(resolve => client!.once("error", resolve));
    await client.query("BEGIN");
    await client.query("SET LOCAL idle_in_transaction_session_timeout = '200ms'");
    const error = await failed;
    assert.equal(error.code, "25P03");
    await assert.rejects(client.query("SELECT 1"), /not queryable/);
    await assert.rejects(client.query("COMMIT"), /not queryable/);
    client.release();
    client = undefined;
    assert.equal(pool.totalCount, 0);
    const recovered = await pool.query("SELECT 1 AS healthy, pg_backend_pid() AS pid");
    assert.equal(recovered.rows[0].healthy, 1);
    assert.notEqual(recovered.rows[0].pid, originalPid);
    assert.equal(pool.idleCount, 1);
  } finally {
    client?.release(true);
    await pool.end();
  }
});
