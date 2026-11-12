import { pool, type PoolClient } from "@workspace/db";
import { notifySessionRevoked } from "../lib/session";

const fail = (message: string, statusCode = 409): never => { throw Object.assign(new Error(message), { statusCode }); };
const quote = (value: string) => `"${value.replaceAll('"', '""')}"`;
type Relation = { name: string; columns: string[]; keys: string[] };
type ForeignKey = { child: string; parent: string; columns: string[]; parent_columns: string[]; nullable: boolean };

/**
 * Discover tenant rows and their FK-owned dependants under write locks. Never
 * cascade into another tenant. Unknown/cyclic mandatory relationships fail
 * closed and roll back, rather than disabling constraints or triggers.
 */
async function purgeOrganization(client: PoolClient, organizationId: string) {
  const { rows: tables } = await client.query<Relation>(`
    SELECT c.relname AS name, array_agg(a.attname::text ORDER BY a.attnum) AS columns,
      ARRAY(SELECT pa.attname::text FROM pg_index i JOIN unnest(i.indkey) WITH ORDINALITY k(attnum, n) ON true
        JOIN pg_attribute pa ON pa.attrelid=i.indrelid AND pa.attnum=k.attnum
        WHERE i.indrelid=c.oid AND i.indisprimary ORDER BY k.n) AS keys
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    JOIN pg_attribute a ON a.attrelid=c.oid AND a.attnum>0 AND NOT a.attisdropped
    WHERE n.nspname='public' AND c.relkind='r' GROUP BY c.oid,c.relname`);
  const { rows: fks } = await client.query<ForeignKey>(`
    SELECT child.relname AS child, parent.relname AS parent,
      array_agg(ca.attname::text ORDER BY k.n) AS columns,
      array_agg(pa.attname::text ORDER BY k.n) AS parent_columns,
      bool_and(NOT ca.attnotnull) AS nullable
    FROM pg_constraint fk JOIN pg_class child ON child.oid=fk.conrelid
    JOIN pg_class parent ON parent.oid=fk.confrelid
    JOIN pg_namespace cn ON cn.oid=child.relnamespace
    JOIN pg_namespace pn ON pn.oid=parent.relnamespace
    JOIN unnest(fk.conkey, fk.confkey) WITH ORDINALITY k(c,p,n) ON true
    JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=k.c
    JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=k.p
    WHERE fk.contype='f' AND cn.nspname='public' AND pn.nspname='public'
    GROUP BY fk.oid,child.relname,parent.relname`);
  // Security audit remains append-only, including the deletion event.
  const selected = new Set(tables.filter(t => t.columns.includes("organization_id") && t.name !== "audit_log").map(t => t.name));
  selected.add("organizations");
  for (let changed = true; changed;) {
    changed = false;
    for (const fk of fks) if (selected.has(fk.parent) && !selected.has(fk.child) && fk.child !== "audit_log") {
      selected.add(fk.child); changed = true;
    }
  }
  const relations = tables.filter(t => selected.has(t.name)).sort((a,b) => a.name.localeCompare(b.name));
  const external = await client.query(`SELECT 1 FROM pg_constraint fk
    JOIN pg_class parent ON parent.oid=fk.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
    JOIN pg_class child ON child.oid=fk.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
    WHERE fk.contype='f' AND pn.nspname='public' AND parent.relname=ANY($1::text[])
      AND (cn.nspname<>'public' OR child.relname='audit_log') LIMIT 1`, [[...selected]]);
  if (external.rowCount) fail("Radering stoppades av externa datakopplingar. Inga uppgifter har raderats.");
  if (relations.some(t => !t.keys.length)) fail("Radering stoppades: en datatabell saknar säker radidentifiering.");
  // Brief administrative operation; timeout rather than wait behind active work.
  await client.query(`LOCK TABLE ${relations.map(t => `public.${quote(t.name)}`).join(",")} IN SHARE ROW EXCLUSIVE MODE`);
  await client.query("CREATE TEMP TABLE lifecycle_rows (table_name text, row_key jsonb, PRIMARY KEY(table_name,row_key)) ON COMMIT DROP");
  const key = (t: Relation, alias: string) => `jsonb_build_array(${t.keys.map(k => `${alias}.${quote(k)}`).join(",")})`;
  const marked = (t: Relation, alias: string) => `EXISTS(SELECT 1 FROM lifecycle_rows lr WHERE lr.table_name='${t.name.replaceAll("'", "''")}' AND lr.row_key=${key(t,alias)})`;
  for (const t of relations) {
    if (t.name !== "organizations" && !t.columns.includes("organization_id")) continue;
    await client.query(`INSERT INTO lifecycle_rows SELECT $1,${key(t,"t")} FROM public.${quote(t.name)} t WHERE t.${t.name === "organizations" ? "id" : "organization_id"}=$2 ON CONFLICT DO NOTHING`, [t.name,organizationId]);
  }
  for (let changed = true; changed;) {
    changed = false;
    for (const fk of fks.filter(f => selected.has(f.child) && selected.has(f.parent))) {
      const child = relations.find(t => t.name === fk.child)!;
      const parent = relations.find(t => t.name === fk.parent)!;
      const join = fk.columns.map((c,i) => `c.${quote(c)}=p.${quote(fk.parent_columns[i])}`).join(" AND ");
      if (child.columns.includes("organization_id")) {
        const conflict = await client.query(`SELECT 1 FROM public.${quote(child.name)} c JOIN public.${quote(parent.name)} p ON ${join} WHERE ${marked(parent,"p")} AND c.organization_id IS DISTINCT FROM $1 LIMIT 1`, [organizationId]);
        if (conflict.rowCount) fail("Radering stoppades: data hänvisar till ett annat kundföretag.");
      }
      const added = await client.query(`INSERT INTO lifecycle_rows SELECT $1,${key(child,"c")} FROM public.${quote(child.name)} c JOIN public.${quote(parent.name)} p ON ${join} WHERE ${marked(parent,"p")} ON CONFLICT DO NOTHING`, [child.name]);
      changed ||= Boolean(added.rowCount);
    }
  }
  const edges = fks.filter(f => selected.has(f.child) && selected.has(f.parent));
  const reaches = (from: string, target: string, seen = new Set<string>()): boolean => {
    if (from === target) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return edges.some(f => f.child === from && reaches(f.parent,target,seen));
  };
  // Explicit tenant teardown releases planner locks, not execution history.
  // Do not rewrite terminal stop membership merely to sort FK deletions.
  await client.query("UPDATE routes SET optimization_frozen=false WHERE organization_id=$1 AND optimization_frozen", [organizationId]);
  await client.query("UPDATE stops SET locked_vehicle_id=NULL,locked_driver_id=NULL,locked_service_start_at=NULL WHERE organization_id=$1 AND (locked_vehicle_id IS NOT NULL OR locked_service_start_at IS NOT NULL)", [organizationId]);
  // Remove nullable cycle edges only on rows already proven to belong to the
  // deletion set. Ordinary database triggers and constraints remain enabled.
  for (const fk of edges.filter(f => f.nullable && reaches(f.parent,f.child))) {
    const child = relations.find(t => t.name === fk.child)!;
    await client.query(`UPDATE public.${quote(child.name)} c SET ${fk.columns.map(c => `${quote(c)}=NULL`).join(",")} WHERE ${marked(child,"c")}`);
  }
  const pending = [...relations];
  while (pending.length) {
    let progress = false;
    for (const t of [...pending]) {
      await client.query("SAVEPOINT lifecycle_delete");
      try {
        await client.query(`DELETE FROM public.${quote(t.name)} t WHERE ${marked(t,"t")}`);
        await client.query("RELEASE SAVEPOINT lifecycle_delete");
        pending.splice(pending.indexOf(t),1); progress = true;
      } catch (error) {
        await client.query("ROLLBACK TO SAVEPOINT lifecycle_delete");
        await client.query("RELEASE SAVEPOINT lifecycle_delete");
        if ((error as {code?:string}).code !== "23503") throw error;
      }
    }
    if (!progress) fail("Radering stoppades av datakopplingar. Inga uppgifter har raderats.");
  }
}

export async function changeOrganizationLifecycle(input: {
  organizationId: string; actorOrganizationId: string; actorId: string;
  action: "archive" | "restore" | "delete"; confirmationName: string;
}) {
  const client = await pool.connect();
  let sessionIds: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout='5s'");
    await client.query("SET LOCAL statement_timeout='30s'");
    // Blocks FK inserts and concurrent execution transitions until commit.
    await client.query("LOCK TABLE organizations, routes, route_executions IN SHARE ROW EXCLUSIVE MODE");
    const { rows: [org] } = await client.query("SELECT id,name,archived_at FROM organizations WHERE id=$1 FOR UPDATE", [input.organizationId]);
    if (!org) fail("Företaget finns inte.",404);
    if (org.name !== input.confirmationName) fail("Företagsnamnet stämmer inte med bekräftelsen.",400);
    const protectedUsers = await client.query("SELECT 1 FROM users WHERE organization_id=$1 AND is_platform_admin=true LIMIT 1", [org.id]);
    if (org.id === input.actorOrganizationId || protectedUsers.rowCount) fail("Företag med superuser-konton kan inte arkiveras eller raderas.");
    if (input.action !== "restore") {
      const active = await client.query("SELECT 1 FROM routes WHERE organization_id=$1 AND status='in_progress' LIMIT 1", [org.id]);
      if (active.rowCount) fail("Företaget har pågående rutter. Avsluta dem innan du arkiverar eller raderar.");
      const executions = await client.query("SELECT 1 FROM route_executions WHERE organization_id=$1 AND status='active' LIMIT 1", [org.id]);
      if (executions.rowCount) fail("Företaget har en pågående körning. Avsluta den innan du arkiverar eller raderar.");
      const outgoing = await client.query(`SELECT 1 FROM routes r JOIN route_dispatch_snapshots ds
        ON ds.route_id=r.id AND ds.plan_revision=r.handoff_version
        WHERE r.organization_id=$1 AND r.status NOT IN ('completed','cancelled')
        AND EXISTS (SELECT 1 FROM jsonb_array_elements(ds.stops) entry JOIN stops s ON s.id::text=entry->>'id'
          WHERE s.organization_id=r.organization_id AND s.status IN ('pending','in_progress')) LIMIT 1`, [org.id]);
      if (outgoing.rowCount) fail("Företaget har utskickade uppdrag som inte avslutats. Avsluta eller avbryt rutten först.");
    }
    if (input.action === "delete" && !org.archived_at) fail("Arkivera företaget innan du raderar det permanent.");
    if (input.action !== "restore") {
      const sessions = await client.query("UPDATE sessions SET revoked_at=now() WHERE organization_id=$1 RETURNING id", [org.id]);
      sessionIds = sessions.rows.map(row => row.id);
    }
    if (input.action === "delete") await purgeOrganization(client,org.id);
    else await client.query("UPDATE organizations SET archived_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$1", [org.id,input.action === "archive"]);
    await client.query(`INSERT INTO audit_log (organization_id,user_id,action,resource_type,resource_id,metadata,method,path,status_code)
      VALUES ($1,$2,$3,'organization',$4,$5::jsonb,'POST','/platform/organizations/lifecycle','204')`, [
      input.actorOrganizationId,input.actorId,`platform.organization.${input.action}`,org.id,
      JSON.stringify({targetOrganizationId:org.id, name:org.name}),
    ]);
    await client.query("COMMIT");
    sessionIds.forEach(notifySessionRevoked);
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally { client.release(); }
}
