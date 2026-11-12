import { pgTable, uuid, text, timestamp, integer, real, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { serviceReportsTable } from "./service-reports";
import { organizationsTable } from "./organizations";

export const serviceReportMaterialsTable = pgTable("service_report_materials", {
  id: uuid("id").defaultRandom().primaryKey(),
  serviceReportId: uuid("service_report_id").references(() => serviceReportsTable.id, { onDelete: "cascade" }).notNull(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  itemCode: text("item_code"),
  description: text("description").notNull(),
  quantity: real("quantity").notNull().default(1),
  unit: text("unit"),
  unitCost: real("unit_cost"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("srm_service_report_id_idx").on(table.serviceReportId),
  index("srm_org_id_idx").on(table.organizationId),
]);

export const insertServiceReportMaterialSchema = createInsertSchema(serviceReportMaterialsTable).omit({ id: true, createdAt: true });
export type InsertServiceReportMaterial = z.infer<typeof insertServiceReportMaterialSchema>;
export type ServiceReportMaterial = typeof serviceReportMaterialsTable.$inferSelect;
