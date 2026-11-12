import { pgTable, uuid, text, timestamp, integer, boolean, pgEnum, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { stopsTable } from "./stops";
import { driversTable } from "./drivers";
import { organizationsTable } from "./organizations";

export const serviceReportStatusEnum = pgEnum("service_report_status", [
  "draft",
  "submitted",
  "billing_ready",
]);

export const serviceReportsTable = pgTable("service_reports", {
  id: uuid("id").defaultRandom().primaryKey(),
  stopId: uuid("stop_id").references(() => stopsTable.id, { onDelete: "cascade" }).notNull(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  driverId: uuid("driver_id").references(() => driversTable.id).notNull(),
  status: serviceReportStatusEnum("status").notNull().default("draft"),
  startedAt: timestamp("started_at"),
  completedAt: timestamp("completed_at"),
  actualDurationMin: integer("actual_duration_min"),
  notes: text("notes"),
  customerSignatoryName: text("customer_signatory_name"),
  /** Reference to a stored signature image (URL or storage key) */
  signatureEvidenceRef: text("signature_evidence_ref"),
  billingReady: boolean("billing_ready").notNull().default(false),
  billingReadyAt: timestamp("billing_ready_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("service_reports_stop_id_unique").on(table.stopId),
  index("service_reports_org_id_idx").on(table.organizationId),
  index("service_reports_driver_id_idx").on(table.driverId),
  index("service_reports_billing_ready_idx").on(table.organizationId, table.billingReady),
  index("service_reports_status_idx").on(table.status),
]);

export const insertServiceReportSchema = createInsertSchema(serviceReportsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertServiceReport = z.infer<typeof insertServiceReportSchema>;
export type ServiceReport = typeof serviceReportsTable.$inferSelect;
