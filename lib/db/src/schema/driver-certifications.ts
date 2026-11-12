import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { driversTable } from "./drivers";
import { organizationsTable } from "./organizations";

export const driverCertificationsTable = pgTable("driver_certifications", {
  id: uuid("id").defaultRandom().primaryKey(),
  driverId: uuid("driver_id").references(() => driversTable.id, { onDelete: "cascade" }).notNull(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  certificationCode: text("certification_code").notNull(),
  certificationName: text("certification_name").notNull(),
  issuedAt: timestamp("issued_at").notNull(),
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("driver_certifications_driver_id_idx").on(table.driverId),
  index("driver_certifications_org_id_idx").on(table.organizationId),
  index("driver_certifications_code_idx").on(table.certificationCode),
]);

export const insertDriverCertificationSchema = createInsertSchema(driverCertificationsTable).omit({ id: true, createdAt: true });
export type InsertDriverCertification = z.infer<typeof insertDriverCertificationSchema>;
export type DriverCertification = typeof driverCertificationsTable.$inferSelect;
