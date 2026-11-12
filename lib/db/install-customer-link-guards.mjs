import pg from "pg";
import { readFile } from "node:fs/promises";

// Additive lifecycle guard: keep the earliest terminal deadline even if a stop
// is reopened, or terminal_at is later cleared by the operational workflow.
const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(await readFile(new URL("./planner-lock-guards.sql", import.meta.url), "utf8"));
  await client.query(`
    CREATE OR REPLACE FUNCTION clamp_customer_link_lifecycle() RETURNS trigger
    LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.status IN ('completed', 'failed', 'skipped') THEN
        UPDATE customer_links
        SET terminal_expires_at = LEAST(terminal_expires_at,
          CASE WHEN NEW.terminal_at IS NULL THEN CURRENT_TIMESTAMP
               ELSE (NEW.terminal_at AT TIME ZONE 'UTC') + interval '24 hours' END),
          expires_at = LEAST(expires_at,
          CASE WHEN NEW.terminal_at IS NULL THEN CURRENT_TIMESTAMP
               ELSE (NEW.terminal_at AT TIME ZONE 'UTC') + interval '24 hours' END)
        WHERE stop_id = NEW.id;
      END IF;
      IF (NEW.route_id IS DISTINCT FROM OLD.route_id AND NOT EXISTS (
           SELECT 1 FROM routes r JOIN route_dispatch_snapshots ds
             ON ds.route_id = r.id AND ds.plan_revision = r.handoff_version
             AND ds.organization_id = r.organization_id
           WHERE r.id = OLD.route_id AND r.organization_id = OLD.organization_id
             AND ds.stops @> jsonb_build_array(jsonb_build_object('id', OLD.id::text))
         ))
         OR NEW.organization_id IS DISTINCT FROM OLD.organization_id
         OR NEW.archived_at IS NOT NULL THEN
        UPDATE customer_links SET revoked_at = COALESCE(revoked_at, CURRENT_TIMESTAMP)
        WHERE stop_id = NEW.id;
      END IF;
      RETURN NEW;
    END $$;
    CREATE OR REPLACE TRIGGER customer_link_lifecycle_guard
    AFTER UPDATE OF status, terminal_at, route_id, organization_id, archived_at ON stops
    FOR EACH ROW EXECUTE FUNCTION clamp_customer_link_lifecycle();
  `);
} finally {
  await client.end();
}