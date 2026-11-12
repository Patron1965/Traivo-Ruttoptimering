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

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

export type PlanningDraftState = { [key: string]: JsonValue };

export type PlanningDraftImportedResult = {
  receivedRowCount: number;
  savedRowCount: number;
  imported: number;
  stopIds: string[];
  rowResults: Array<{
    sourceRowNumber: number;
    status: "saved";
    stopId: string;
  }>;
  stops?: unknown[];
};

export const planningDraftsTable = pgTable("planning_drafts", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  name: text("name").notNull(),
  startAt: timestamp("start_at", { withTimezone: true }).notNull(),
  state: jsonb("state").$type<PlanningDraftState>().notNull().default({}),
  revision: integer("revision").notNull().default(0),
  importedPayloadHash: text("imported_payload_hash"),
  importedResult: jsonb("imported_result").$type<PlanningDraftImportedResult>(),
  planId: uuid("plan_id"),
  planPayloadHash: text("plan_payload_hash"),
  planResult: jsonb("plan_result").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
}, (table) => [
  index("planning_drafts_organization_id_idx").on(table.organizationId),
  index("planning_drafts_org_updated_at_idx").on(table.organizationId, table.updatedAt),
]);

export const insertPlanningDraftSchema = createInsertSchema(planningDraftsTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
  revision: true,
  importedPayloadHash: true,
  importedResult: true,
  planId: true,
  planPayloadHash: true,
  planResult: true,
});
export type InsertPlanningDraft = z.infer<typeof insertPlanningDraftSchema>;
export type PlanningDraft = typeof planningDraftsTable.$inferSelect;