import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  acceptanceTables, acquireSchemaLock, releaseSchemaLock, verifyDevelopment,
  inventorySchemas, schemaMarker, dropApprovedSchema, type SqlConnection,
} from "./district-schema-policy";

// Requires separate operator approval, not merely policy approval.
// All DDL is contained in one outer transaction and finally rolled back.
test("actual copied defaults are eligible, external views/FKs are refused, own fixture deletion works",
  { skip: process.env.DISTRICT_SCHEMA_CATALOG_APPROVED !== "1" }, async () => {
    const { pool } = await import("@workspace/db");
    const client = await pool.connect();
    const suffix = randomUUID().replaceAll("-", "");
    const schema = `district_real_${suffix}`;
    const outside = `district_dependency_test_${suffix}`;
    let locked = false;
    let transaction = false;
    try {
      const fingerprint = await verifyDevelopment(client);
      await acquireSchemaLock(client, true);
      locked = true;
      await client.query("BEGIN");
      transaction = true;
      await client.query(`CREATE SCHEMA "${schema}"`);
      await client.query(`CREATE SCHEMA "${outside}"`);
      const comment = schemaMarker(fingerprint, new Date(Date.now() + 86_400_000).toISOString()).replaceAll("'", "''");
      await client.query(`COMMENT ON SCHEMA "${schema}" IS '${comment}'`);
      for (const table of acceptanceTables) {
        await client.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
      }
      const defaults = await client.query(
        `SELECT count(*)::int AS count FROM pg_attrdef ad JOIN pg_class c ON c.oid=ad.adrelid
         JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1`, [schema],
      );
      assert.ok(defaults.rows[0].count > 0, "Fixture must exercise actual copied defaults.");
      const inspect = async () => {
        const result = (await inventorySchemas(client, fingerprint)).find(row => row.schema === schema);
        assert.ok(result);
        return result;
      };
      const valid = await inspect();
      assert.equal(valid.reason, "registered", "Normal acceptance layout must be deletable.");
      assert.ok(valid.eligible);

      // Use savepoints: refused attempts and synthetic dependencies never escape
      // this transaction and never touch ordinary customer tables.
      const nested: SqlConnection = { async query(sql, values) {
        const mapped = sql === "BEGIN" ? "SAVEPOINT cleanup_attempt"
          : sql === "COMMIT" ? "RELEASE SAVEPOINT cleanup_attempt"
          : sql === "ROLLBACK" ? "ROLLBACK TO SAVEPOINT cleanup_attempt" : sql;
        return client.query(mapped, values);
      } };
      const approval = `${schema}:${valid.oid}`;
      await client.query("SAVEPOINT view_case");
      await client.query(`CREATE VIEW "${outside}".fixture_view AS SELECT id FROM "${schema}".organizations`);
      assert.equal((await inspect()).reason, "external_dependencies");
      await assert.rejects(dropApprovedSchema(nested, fingerprint, approval));
      assert.equal((await client.query(
        "SELECT count(*)::int AS count FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=$1 AND c.relname='fixture_view'",
        [outside],
      )).rows[0].count, 1);
      await client.query("ROLLBACK TO SAVEPOINT view_case");

      await client.query("SAVEPOINT fk_case");
      await client.query(`CREATE TABLE "${outside}".fixture_ref (
        organization_id uuid REFERENCES "${schema}".organizations(id))`);
      assert.equal((await inspect()).reason, "external_dependencies");
      await assert.rejects(dropApprovedSchema(nested, fingerprint, approval));
      await client.query("ROLLBACK TO SAVEPOINT fk_case");
      assert.ok((await inspect()).eligible);

      const result = await dropApprovedSchema(nested, fingerprint, approval);
      assert.equal(result.outcome, "deleted");
      assert.equal((await client.query(
        "SELECT count(*)::int AS count FROM pg_namespace WHERE nspname=$1", [schema],
      )).rows[0].count, 0);
    } finally {
      if (transaction) await client.query("ROLLBACK");
      if (locked) await releaseSchemaLock(client, true);
      client.release();
      await pool.end();
    }
  });