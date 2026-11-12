import assert from "node:assert/strict";
import { test } from "node:test";
import {
  acceptanceTables, acquireSchemaLock, dropApprovedSchema, inventorySchemas,
  parseApproval, registeredSchema, schemaMarker, verifyDevelopment, type SqlConnection,
} from "./district-schema-policy";

const fingerprint = "a".repeat(32);
const schema = `district_real_${"b".repeat(32)}`;
const comment = schemaMarker(fingerprint, new Date(Date.now() + 86_400_000).toISOString());
function fixture(options: { name?: string; oid?: string; owned?: boolean; comment?: string;
  extra?: boolean; dependency?: boolean; busy?: boolean; failDrop?: boolean } = {}) {
  const calls: string[] = [];
  const connection: SqlConnection = { async query(sql) {
    calls.push(sql);
    if (sql.includes("AS fingerprint")) return { rows: [{ fingerprint }] };
    if (sql.includes("AS locked")) return { rows: [{ locked: !options.busy }] };
    if (sql.includes("obj_description")) return { rows: [{
      nspname: options.name ?? schema, oid: options.oid ?? "123",
      owned: options.owned ?? true, comment: options.comment ?? comment,
    }] };
    if (sql.includes("SELECT c.relname")) return { rows: [
      ...acceptanceTables.map(relname => ({ relname, relkind: "r" })),
      ...(options.extra ? [{ relname: "customer_orders", relkind: "r" }] : []),
    ] };
    if (sql.includes("pg_depend")) return { rows: options.dependency ? [{}] : [] };
    if (sql.startsWith("DROP") && options.failDrop) throw new Error("lock timeout");
    return { rows: [] };
  } };
  return { connection, calls };
}

test("only exact names and namespace identities can be approved", () => {
  assert.deepEqual(parseApproval(`${schema}:123`), { schema, oid: "123" });
  for (const value of ["public:123", `${schema}:0`, `${schema}:123:extra`, `${schema}';DROP:123`, schema])
    assert.throws(() => parseApproval(value));
});
test("registration refuses legacy, corrupt and foreign-database markers", () => {
  assert.ok(registeredSchema(comment, fingerprint));
  for (const value of [null, "", "traivo-district-real-v1:{", comment.replace(fingerprint, "c".repeat(32))])
    assert.equal(registeredSchema(value, fingerprint), false);
});
test("inventory refuses ordinary data, unknown objects, owners and dependencies", async () => {
  for (const options of [
    { name: "district_real_customer" }, { owned: false }, { comment: "" },
    { extra: true }, { dependency: true },
  ]) {
    const { connection, calls } = fixture(options);
    assert.equal((await inventorySchemas(connection, fingerprint))[0].eligible, false);
    assert.ok(!calls.some(sql => sql.startsWith("DROP")));
  }
});
test("exclusive cleanup lock fails closed during a live shared lease", async () => {
  const { connection, calls } = fixture({ busy: true });
  await assert.rejects(acquireSchemaLock(connection, true));
  assert.ok(calls[0].includes("pg_try_advisory_lock("));
  const shared = fixture();
  await acquireSchemaLock(shared.connection);
  assert.ok(shared.calls[0].includes("pg_try_advisory_lock_shared("));
});
test("OID replacement and unregistered schemas cannot be deleted", async () => {
  for (const options of [{ oid: "124" }, { comment: "" }, { dependency: true }]) {
    const { connection, calls } = fixture(options);
    await assert.rejects(dropApprovedSchema(connection, fingerprint, `${schema}:123`));
    assert.ok(calls.includes("ROLLBACK"));
    assert.ok(!calls.some(sql => sql.startsWith("DROP")));
  }
});
test("approved deletion rechecks eligibility transactionally and rolls back on failure", async () => {
  const good = fixture();
  await dropApprovedSchema(good.connection, fingerprint, `${schema}:123`);
  assert.ok(good.calls.indexOf("BEGIN") < good.calls.findIndex(s => s.includes("obj_description")));
  assert.ok(good.calls.includes(`DROP SCHEMA "${schema}" CASCADE`));
  assert.equal(good.calls.at(-1), "COMMIT");
  const failure = fixture({ failDrop: true });
  await assert.rejects(dropApprovedSchema(failure.connection, fingerprint, `${schema}:123`));
  assert.equal(failure.calls.at(-1), "ROLLBACK");
});
test("runtime guard requires independent development proof and rejects deployment", async () => {
  const old = { node: process.env.NODE_ENV, deployment: process.env.REPLIT_DEPLOYMENT, fp: process.env.DEV_DB_FINGERPRINT };
  try {
    process.env.NODE_ENV = "test";
    delete process.env.REPLIT_DEPLOYMENT;
    process.env.DEV_DB_FINGERPRINT = fingerprint;
    assert.equal(await verifyDevelopment(fixture().connection), fingerprint);
    process.env.REPLIT_DEPLOYMENT = "1";
    await assert.rejects(verifyDevelopment(fixture().connection));
    delete process.env.REPLIT_DEPLOYMENT;
    process.env.DEV_DB_FINGERPRINT = "d".repeat(32);
    await assert.rejects(verifyDevelopment(fixture().connection));
    process.env.NODE_ENV = "production";
    await assert.rejects(verifyDevelopment(fixture().connection));
  } finally {
    for (const [key, value] of Object.entries({ NODE_ENV: old.node, REPLIT_DEPLOYMENT: old.deployment, DEV_DB_FINGERPRINT: old.fp })) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
  }
});