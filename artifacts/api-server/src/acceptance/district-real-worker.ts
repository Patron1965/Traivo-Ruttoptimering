import assert from "node:assert/strict";
import { pool } from "@workspace/db";
import { tickDistrictWorker } from "../services/district-worker";
import { acquireSchemaLock, releaseSchemaLock, verifyDevelopment } from "./district-schema-policy";

async function main() {
  assert.equal(process.env.NODE_ENV, "test");
  assert.notEqual(process.env.REPLIT_DEPLOYMENT, "1");
  const schema = process.env.DISTRICT_ACCEPTANCE_SCHEMA ?? "";
  assert.match(schema, /^district_real_[a-f0-9]{32}$/);
  const lease = await pool.connect();
  lease.on("error", () => {
    console.error("District database lease was lost; worker stopped.");
    process.exit(1);
  });
  let locked = false;
  try {
    await verifyDevelopment(lease);
    await acquireSchemaLock(lease);
    locked = true;
    pool.options.max = 2;
    pool.options.options = `-c search_path=${schema}`;
    const client = await pool.connect();
    try { await client.query(`SET search_path TO "${schema}"`); } finally { client.release(); }
    await tickDistrictWorker();
  } finally {
    if (locked) await releaseSchemaLock(lease);
    lease.release();
    await pool.end();
  }
}
main().catch(() => { console.error("Isolated acceptance worker failed."); process.exitCode = 1; });