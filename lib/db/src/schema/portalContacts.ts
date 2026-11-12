import { pgTable, uuid, text, boolean } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { vehiclesTable } from "./vehicles";
import { createInsertSchema } from "drizzle-zod";

export const portalContactsTable = pgTable("portal_contacts", {
  vehicleId: uuid("vehicle_id").primaryKey().references(() => vehiclesTable.id, { onDelete: "cascade" }),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  name: text("name").notNull(),
  phone: text("phone").notNull(),
  enabled: boolean("enabled").notNull().default(false),
});
export const insertPortalContactSchema = createInsertSchema(portalContactsTable);
