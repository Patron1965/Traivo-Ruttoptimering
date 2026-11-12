import assert from "node:assert/strict";

// A dedicated connection MUST retain these session locks until all DB work ends.
export interface SqlConnection {
  query(sql: string, values?: unknown[]): Promise<{ rows: any[] }>;
}
export const schemaPattern = /^district_real_[a-f0-9]{32}$/;
export const fingerprintSql = "SELECT md5(current_database() || ':' || coalesce(inet_server_addr()::text, 'local') || ':' || current_setting('server_version')) AS fingerprint";
export const acceptanceTables = [
  "organizations", "organization_routing_providers", "users", "sessions", "audit_log",
  "district_plans", "district_imports", "district_zones", "district_points",
  "district_jobs", "district_exports",
];
const lockNamespace = 132047;
const lockKey = 1;
const marker = "traivo-district-real-v1:";

export async function verifyDevelopment(connection: SqlConnection) {
  assert.equal(process.env.NODE_ENV, "test", "Use the isolated test runtime.");
  assert.notEqual(process.env.REPLIT_DEPLOYMENT, "1", "Published runtimes are forbidden.");
  assert.match(process.env.DEV_DB_FINGERPRINT ?? "", /^[a-f0-9]{32}$/, "Verify development via executeSql first.");
  const { rows } = await connection.query(fingerprintSql);
  assert.equal(rows[0].fingerprint, process.env.DEV_DB_FINGERPRINT, "Not the verified development connection.");
  return rows[0].fingerprint as string;
}

export async function acquireSchemaLock(connection: SqlConnection, exclusive = false) {
  const fn = exclusive ? "pg_try_advisory_lock" : "pg_try_advisory_lock_shared";
  const { rows } = await connection.query(`SELECT ${fn}($1, $2) AS locked`, [lockNamespace, lockKey]);
  assert.equal(rows[0].locked, true, "District acceptance or cleanup is in progress; no changes made.");
}

export async function releaseSchemaLock(connection: SqlConnection, exclusive = false) {
  const fn = exclusive ? "pg_advisory_unlock" : "pg_advisory_unlock_shared";
  await connection.query(`SELECT ${fn}($1, $2)`, [lockNamespace, lockKey]);
}

export function schemaMarker(fingerprint: string, expiresAt: string) {
  assert.ok(Number.isFinite(Date.parse(expiresAt)));
  return marker + JSON.stringify({ fingerprint, createdAt: new Date().toISOString(), expiresAt });
}

export function registeredSchema(comment: unknown, fingerprint: string): boolean {
  if (typeof comment !== "string" || !comment.startsWith(marker)) return false;
  try {
    const value = JSON.parse(comment.slice(marker.length));
    return value.fingerprint === fingerprint && Number.isFinite(Date.parse(value.createdAt))
      && Number.isFinite(Date.parse(value.expiresAt)) && Date.parse(value.expiresAt) > Date.parse(value.createdAt);
  } catch { return false; }
}

export type SchemaInventory = { schema: string; oid: string; eligible: boolean; reason: string };
export async function inventorySchemas(connection: SqlConnection, fingerprint: string): Promise<SchemaInventory[]> {
  const { rows } = await connection.query(
    `SELECT nspname, oid::text, pg_get_userbyid(nspowner) = current_user AS owned,
      obj_description(oid, 'pg_namespace') AS comment
     FROM pg_namespace WHERE nspname LIKE 'district_real_%' ORDER BY nspname`,
  );
  const result: SchemaInventory[] = [];
  for (const row of rows) {
    let reason = "registered";
    if (!schemaPattern.test(row.nspname)) reason = "invalid_name";
    else if (!row.owned) reason = "different_owner";
    else if (!registeredSchema(row.comment, fingerprint)) reason = "unregistered_requires_manual_investigation";
    else {
      const objects = await connection.query(
        `SELECT c.relname, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
         WHERE n.nspname=$1 AND c.relkind NOT IN ('i','S','t')`, [row.nspname],
      );
      if (objects.rows.length !== acceptanceTables.length || objects.rows.some(
        o => o.relkind !== "r" || !acceptanceTables.includes(o.relname),
      )) reason = "unexpected_objects";
      const routines = await connection.query(
        `SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
         WHERE n.nspname=$1 LIMIT 1`, [row.nspname],
      );
      if (routines.rows.length) reason = "unexpected_objects";
      const dependencies = await connection.query(
        `SELECT 1 FROM pg_depend d
         CROSS JOIN LATERAL pg_identify_object(d.refclassid,d.refobjid,d.refobjsubid) ref
         CROSS JOIN LATERAL pg_identify_object(d.classid,d.objid,d.objsubid) dep
         LEFT JOIN pg_attrdef ad ON d.classid='pg_attrdef'::regclass AND ad.oid=d.objid
         LEFT JOIN pg_rewrite rw ON d.classid='pg_rewrite'::regclass AND rw.oid=d.objid
         LEFT JOIN pg_constraint con ON d.classid='pg_constraint'::regclass AND con.oid=d.objid
         LEFT JOIN pg_trigger tg ON d.classid='pg_trigger'::regclass AND tg.oid=d.objid
         LEFT JOIN pg_policy pol ON d.classid='pg_policy'::regclass AND pol.oid=d.objid
         LEFT JOIN pg_class owner ON owner.oid=coalesce(ad.adrelid,rw.ev_class,
           nullif(con.conrelid,0),tg.tgrelid,pol.polrelid)
         LEFT JOIN pg_namespace owner_ns ON owner_ns.oid=owner.relnamespace
         WHERE ref.schema=$1 AND d.deptype IN ('n','a')
           AND (coalesce(dep.schema,owner_ns.nspname) IS NULL
             OR coalesce(dep.schema,owner_ns.nspname) <> $1) LIMIT 1`, [row.nspname],
      );
      if (dependencies.rows.length) reason = "external_dependencies";
    }
    result.push({ schema: row.nspname, oid: row.oid, eligible: reason === "registered", reason });
  }
  return result;
}

// Approval binds to the exact namespace OID, not merely a reusable name.
export function parseApproval(value: string): { schema: string; oid: string } {
  const [schema, oid, extra] = value.split(":");
  assert.ok(!extra && schemaPattern.test(schema) && /^[1-9][0-9]*$/.test(oid ?? ""), "Expected exact schema:oid approval.");
  return { schema, oid };
}

export async function dropApprovedSchema(connection: SqlConnection, fingerprint: string, approval: string) {
  const requested = parseApproval(approval);
  // Caller holds the exclusive global session lock and the shared OS cache lock.
  await connection.query("BEGIN");
  try {
    await connection.query("SET LOCAL lock_timeout = '2s'");
    const current = (await inventorySchemas(connection, fingerprint)).find(s => s.schema === requested.schema);
    assert.ok(current?.eligible && current.oid === requested.oid, "Approval no longer matches a safe registered schema.");
    // Block even uncoordinated DDL from introducing an external FK/view between
    // the dependency check and CASCADE. Never wait indefinitely for live work.
    const tables = acceptanceTables.map(table => `"${requested.schema}"."${table}"`).join(", ");
    await connection.query(`LOCK TABLE ${tables} IN ACCESS EXCLUSIVE MODE`);
    const locked = (await inventorySchemas(connection, fingerprint)).find(s => s.schema === requested.schema);
    assert.ok(locked?.eligible && locked.oid === requested.oid, "Schema changed while locking.");
    await connection.query(`DROP SCHEMA "${requested.schema}" CASCADE`);
    await connection.query("COMMIT");
    return { ...requested, outcome: "deleted" };
  } catch (error) {
    await connection.query("ROLLBACK");
    throw error;
  }
}