import {
  pgTable,
  uuid,
  text,
  timestamp,
  integer,
  jsonb,
  index,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { planningDraftsTable } from "./planningDrafts";

export const importPlanProgressTable = pgTable(
  "import_plan_progress",
  {
    id: uuid("id").primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id, { onDelete: "cascade" })
      .notNull(),
    draftId: uuid("draft_id").references(() => planningDraftsTable.id, {
      onDelete: "cascade",
    }),
    status: text("status").notNull(),
    phase: text("phase").notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    progress: jsonb("progress").$type<Record<string, unknown>>().notNull().default({}),
    estimatedRemainingMs: integer("estimated_remaining_ms"),
    planId: uuid("plan_id"),
    error: jsonb("error").$type<Record<string, unknown> | null>(),
    result: jsonb("result").$type<Record<string, unknown> | null>(),
  },
  (table) => [
    index("import_plan_progress_organization_id_idx").on(table.organizationId),
    index("import_plan_progress_org_updated_at_idx").on(
      table.organizationId,
      table.updatedAt,
    ),
  ],
);

export const insertImportPlanProgressSchema = createInsertSchema(
  importPlanProgressTable,
);
export type InsertImportPlanProgress = z.infer<
  typeof insertImportPlanProgressSchema
>;
export type ImportPlanProgress = typeof importPlanProgressTable.$inferSelect;