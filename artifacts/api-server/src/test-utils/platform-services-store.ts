import assert from "node:assert/strict";
import type { SQL } from "drizzle-orm";
import { PgDialect } from "drizzle-orm/pg-core";
import { organizationsTable, organizationServicePoliciesTable, auditLogTable } from "@workspace/db/schema";

type PolicyRow = typeof organizationServicePoliciesTable.$inferInsert;
type AuditRow = typeof auditLogTable.$inferInsert;
type State = { policies: Map<string, PolicyRow>; audits: AuditRow[] };

/**
 * Deliberately narrow, fail-closed adapter for platform-services request tests.
 * Imports schema only: no Pool, DATABASE_URL, network or real customer records.
 * This tests route persistence decisions, not PostgreSQL locking semantics.
 */
export function createPlatformServicesStore(organizationIds: string[]) {
  const organizations = new Set(organizationIds);
  let state: State = { policies: new Map(), audits: [] };
  let writes = 0;
  const dialect = new PgDialect();

  function adapter(current: State, transactional: boolean) {
    return {
      select() {
        return {
          from(table: unknown) {
            assert.ok(table === organizationsTable || table === organizationServicePoliciesTable);
            return {
              where(condition: SQL) {
                const query = dialect.sqlToQuery(condition);
                const column = table === organizationsTable
                  ? '"organizations"."id"' : '"organization_service_policies"."organization_id"';
                assert.equal(query.sql, `${column} = $1`, "Unexpected fixture query");
                assert.equal(query.params.length, 1);
                const id = query.params[0] as string;
                const rows = table === organizationsTable
                  ? (organizations.has(id) ? [{ id }] : [])
                  : (current.policies.has(id) ? [structuredClone(current.policies.get(id)!)] : []);
                return Object.assign(Promise.resolve(rows), {
                  for(lock: string) {
                    assert.equal(transactional, true);
                    assert.equal(lock, "update");
                    return Promise.resolve(rows);
                  },
                });
              },
            };
          },
        };
      },
      insert(table: unknown) {
        assert.equal(transactional, true, "Writes must use the transaction");
        assert.ok(table === organizationServicePoliciesTable || table === auditLogTable);
        return {
          values(value: PolicyRow | AuditRow) {
            if (table === auditLogTable) {
              writes++;
              current.audits.push(structuredClone(value as AuditRow));
              return Promise.resolve();
            }
            return {
              async onConflictDoUpdate(options: { target: unknown; set: Partial<PolicyRow> }) {
                assert.equal(options.target, organizationServicePoliciesTable.organizationId);
                const row = value as PolicyRow;
                assert.ok(organizations.has(row.organizationId));
                writes++;
                const old = current.policies.get(row.organizationId);
                current.policies.set(row.organizationId, structuredClone(old ? { ...old, ...options.set } : row));
              },
            };
          },
        };
      },
    };
  }

  return {
    db: {
      select: () => adapter(state, false).select(),
      async transaction<T>(callback: (tx: ReturnType<typeof adapter>) => Promise<T>) {
        const draft = structuredClone(state);
        const result = await callback(adapter(draft, true));
        state = draft;
        return result;
      },
    },
    reset() { state = { policies: new Map(), audits: [] }; writes = 0; },
    snapshot: () => structuredClone(state),
    writeCount: () => writes,
  };
}
