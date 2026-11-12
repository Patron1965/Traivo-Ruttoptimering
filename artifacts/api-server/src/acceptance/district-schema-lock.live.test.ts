import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acquireSchemaLock, releaseSchemaLock, verifyDevelopment, inventorySchemas,
} from "./district-schema-policy";

// Explicit opt-in: SELECT-only inventory and session advisory locks, no fixtures,
// coordinate reads, DDL, deletion, geocoding or provider requests.
test("real development sessions protect a surviving worker and release after disconnect",
  { skip: process.env.DISTRICT_SCHEMA_LOCK_TEST !== "1" }, async () => {
    const { pool } = await import("@workspace/db");
    const harness = await pool.connect();
    const worker = await pool.connect();
    const cleaner = await pool.connect();
    let harnessLocked = false, workerLocked = false, cleanerLocked = false;
    try {
      const fingerprint = await verifyDevelopment(harness);
      await verifyDevelopment(worker);
      await verifyDevelopment(cleaner);
      await acquireSchemaLock(harness);
      harnessLocked = true;
      await acquireSchemaLock(worker);
      workerLocked = true;
      await assert.rejects(acquireSchemaLock(cleaner, true));
      // Destroy the harness connection, as occurs after SIGKILL.
      harness.release(true);
      harnessLocked = false;
      // PostgreSQL may notice the disconnect asynchronously. The worker still
      // holds its own shared lease regardless of that timing.
      await assert.rejects(acquireSchemaLock(cleaner, true));
      await releaseSchemaLock(worker);
      workerLocked = false;
      for (let attempt = 0; attempt < 100; attempt++) {
        try {
          await acquireSchemaLock(cleaner, true);
          cleanerLocked = true;
          break;
        } catch {
          await new Promise(resolve => setTimeout(resolve, 10));
        }
      }
      assert.ok(cleanerLocked, "Exclusive lock was not released after the harness disconnected.");
      const inventory = await inventorySchemas(cleaner, fingerprint);
      assert.ok(Array.isArray(inventory));
    } finally {
      if (cleanerLocked) await releaseSchemaLock(cleaner, true);
      if (workerLocked) await releaseSchemaLock(worker);
      if (harnessLocked) {
        await releaseSchemaLock(harness);
        harness.release();
      }
      worker.release();
      cleaner.release();
      await pool.end();
    }
  });