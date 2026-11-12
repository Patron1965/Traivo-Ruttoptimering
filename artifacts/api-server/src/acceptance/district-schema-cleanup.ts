import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { resolve } from "node:path";
import { pool } from "@workspace/db";
import {
  acquireSchemaLock, releaseSchemaLock, verifyDevelopment,
  inventorySchemas, parseApproval, dropApprovedSchema,
} from "./district-schema-policy";

async function main() {
  const args = process.argv.slice(2);
  assert.ok(args.length === 0 || (args.length === 2 && args[0] === "--approve-drop"),
    "Dry run: no arguments. Deletion: --approve-drop exact_schema:oid, only after explicit operator approval.");
  if (args.length) parseApproval(args[1]);
  const connection = await pool.connect();
  let locked = false;
  let lease: ReturnType<typeof spawn> | undefined;
  let ended: Promise<unknown> | undefined;
  let releasing = false;
  try {
    const fingerprint = await verifyDevelopment(connection);
    if (args.length) {
      // Reuse the existing OS lock without invoking file retention or geocoding.
      lease = spawn("python", [resolve("../../scripts/district-cache-retention.py"), "--hold-lock-only"],
        { stdio: ["pipe", "pipe", "pipe"] });
      ended = once(lease, "exit");
      lease.stderr?.on("data", () => {});
      await new Promise<void>((success, failure) => {
        lease!.once("error", failure);
        lease!.once("exit", () => failure(new Error("District cache lease unavailable.")));
        let output = "";
        lease!.stdout!.on("data", chunk => { output += chunk.toString(); if (output === "LOCKED\n") success(); });
      });
      lease.on("exit", () => { if (!releasing) process.exit(1); });
      await acquireSchemaLock(connection, true);
      locked = true;
    }
    const inventory = await inventorySchemas(connection, fingerprint);
    console.log(JSON.stringify({ environment: "development", recordedAt: new Date().toISOString(), inventory }));
    if (args.length) {
      console.log(JSON.stringify(await dropApprovedSchema(connection, fingerprint, args[1])));
    }
  } finally {
    if (locked) await releaseSchemaLock(connection, true);
    connection.release();
    await pool.end();
    releasing = true;
    lease?.stdin?.end();
    if (ended) {
      const [code] = await ended as [number | null];
      assert.equal(code, 0, "District cache lease failed.");
    }
  }
}
main().catch(() => {
  // DB errors may embed source data, URLs or connection credentials.
  console.error("District schema cleanup refused or failed; inspect the non-sensitive inventory and policy.");
  process.exitCode = 1;
});