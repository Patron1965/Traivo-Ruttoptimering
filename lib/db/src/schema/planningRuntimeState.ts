import { pgTable, text, uuid, timestamp, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

// Operational execution state, not a second source of truth for routes/jobs.
// Route writes still go through the canonical transactional mutation services.
export const planningRuntimeStateTable = pgTable("planning_runtime_state", {
  key: text("key").primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id, { onDelete: "cascade" }),
  kind: text("kind").notNull(),
  payload: text("payload").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, (table) => [
  index("planning_runtime_state_org_kind_idx").on(table.organizationId, table.kind),
  index("planning_runtime_state_expiry_idx").on(table.expiresAt),
]);
