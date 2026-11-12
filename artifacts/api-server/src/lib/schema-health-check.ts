import { sql } from "drizzle-orm";
import { db } from "@workspace/db";

interface ColumnCheck {
  table: string;
  column: string;
}

interface TableCheck {
  table: string;
}

const REQUIRED_COLUMNS: ColumnCheck[] = [
  { table: "customer_sites", column: "is_prioritized" },
  { table: "planning_runtime_state", column: "organization_id" },
  { table: "planning_runtime_state", column: "expires_at" },
  { table: "district_intakes", column: "plan_id" },
  { table: "district_intakes", column: "source_key" },
  { table: "district_intakes", column: "payload_hash" },
  { table: "district_intakes", column: "source_draft_id" },
  { table: "district_intakes", column: "source_draft_revision" },
  { table: "district_intakes", column: "revision" },
  { table: "district_intakes", column: "rows" },
  { table: "users", column: "is_platform_admin" },
  { table: "vehicle_positions", column: "execution_id" },
  { table: "vehicle_positions", column: "start_client_event_id" },
  { table: "customer_links", column: "terminal_expires_at" },
  // Transport / P&D
  { table: "stops", column: "pickup_address" },
  { table: "stops", column: "pickup_latitude" },
  { table: "stops", column: "pickup_longitude" },
  { table: "delivery_proofs", column: "proof_stage" },
  { table: "routes", column: "manual_review_required" },
  { table: "routes", column: "manual_reviewed_at" },
  { table: "routes", column: "plan_revision" },
  { table: "routes", column: "geographic_overlap_explanation" },
  // Field service — stops
  { table: "stops", column: "job_type" },
  { table: "stops", column: "priority" },
  { table: "stops", column: "sla_deadline" },
  { table: "stops", column: "service_category" },
  { table: "stops", column: "service_instructions" },
  { table: "stops", column: "required_skills" },
  { table: "stops", column: "required_certifications" },
  { table: "stops", column: "required_equipment" },
  { table: "stops", column: "terminal_at" },
  // Field service — drivers
  { table: "drivers", column: "driver_role" },
  { table: "drivers", column: "skills" },
  // Field service — vehicles
  { table: "vehicles", column: "equipment_inventory" },
  // Field service — organizations
  { table: "organizations", column: "operating_mode" },
  { table: "organizations", column: "stop_retention_enabled" },
  { table: "organizations", column: "stop_retention_days" },
  // Field service — certifications
  { table: "driver_certifications", column: "driver_id" },
  { table: "driver_certifications", column: "certification_code" },
  { table: "driver_certifications", column: "expires_at" },
  // Field service — service reports
  { table: "service_reports", column: "stop_id" },
  { table: "service_reports", column: "billing_ready" },
  { table: "service_reports", column: "billing_ready_at" },
  { table: "service_reports", column: "signature_evidence_ref" },
  // Field service — service report materials
  { table: "service_report_materials", column: "service_report_id" },
  { table: "service_report_materials", column: "description" },
  { table: "service_report_materials", column: "quantity" },
  { table: "organization_routing_providers", column: "organization_id" },
  { table: "organization_routing_providers", column: "server_id" },
  { table: "organization_routing_providers", column: "updated_at" },
];

const REQUIRED_TABLES: TableCheck[] = [
  { table: "customer_links" },
  { table: "documents" },
  { table: "driver_certifications" },
  { table: "service_reports" },
  { table: "service_report_materials" },
  { table: "password_reset_tokens" },
  { table: "organization_routing_providers" },
];

/**
 * Queries information_schema to verify that all critical columns and tables
 * exist in the production database. Logs a clear, actionable message for each
 * gap found and exits with code 1 if the schema is out of sync.
 *
 * Must be called before the HTTP server starts accepting requests so that
 * a deploy with a stale schema is marked failed rather than silently broken.
 */
export async function checkSchemaHealth(): Promise<void> {
  const start = Date.now();

  // --- Check required columns ---
  const columnRows = await db.execute<{ table_name: string; column_name: string }>(sql`
    SELECT table_name, column_name
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND (table_name, column_name) IN (
        ${sql.join(
          REQUIRED_COLUMNS.map((c) => sql`(${c.table}, ${c.column})`),
          sql`, `
        )}
      )
  `);

  const foundColumns = new Set(
    columnRows.rows.map((r) => `${r.table_name}.${r.column_name}`)
  );

  const missingColumns = REQUIRED_COLUMNS.filter(
    (c) => !foundColumns.has(`${c.table}.${c.column}`)
  );

  // --- Check required tables ---
  const tableRows = await db.execute<{ table_name: string }>(sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name IN (
        ${sql.join(
          REQUIRED_TABLES.map((t) => sql`${t.table}`),
          sql`, `
        )}
      )
  `);

  const foundTables = new Set(tableRows.rows.map((r) => r.table_name));

  const missingTables = REQUIRED_TABLES.filter(
    (t) => !foundTables.has(t.table)
  );

  // This additive guard makes link deadlines monotonic across every stop
  // writer, including bulk SQL/geofence/execution transitions. Never serve a
  // deployment which copied the table but omitted the lifecycle guard.
  const lifecycleGuard = await db.execute<{ present: boolean }>(sql`
    SELECT EXISTS (
      SELECT 1 FROM pg_trigger t
      JOIN pg_class c ON c.oid = t.tgrelid
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relname = 'stops'
        AND t.tgname = 'customer_link_lifecycle_guard'
        AND NOT t.tgisinternal AND t.tgenabled <> 'D'
    ) AS present
  `);
  const customerLinkGuardPresent = lifecycleGuard.rows[0]?.present === true;
  const elapsed = Date.now() - start;

  // --- Report results ---
  if (missingColumns.length === 0 && missingTables.length === 0 && customerLinkGuardPresent) {
    console.log(`[schema-health] All required tables and columns present (${elapsed} ms)`);
    return;
  }

  console.error(`[schema-health] *** SCHEMA OUT OF SYNC — ${elapsed} ms ***`);

  for (const { table, column } of missingColumns) {
    console.error(`[schema-health]   MISSING COLUMN  : ${table}.${column}`);
  }
  for (const { table } of missingTables) {
    console.error(`[schema-health]   MISSING TABLE   : ${table}`);
  }
  if (!customerLinkGuardPresent) {
    console.error("[schema-health]   MISSING GUARD   : customer_link_lifecycle_guard (secure customer-link lifecycle)");
  }

  console.error(
    "[schema-health] Development: run the configured post-merge schema push. Production: publish again so Replit applies the managed development-to-production schema diff."
  );

  process.exit(1);
}
