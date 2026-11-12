import { pgTable, uuid, text, timestamp, index, jsonb } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export type CustomerUnavailablePeriod = {
  weekday: number;
  start: string;
  end: string;
};

export const customersTable = pgTable("customers", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  name: text("name").notNull(),
  email: text("email"),
  phone: text("phone"),
  address: text("address"),
  customerNumber: text("customer_number"),
  organizationNumber: text("organization_number"),
  contactName: text("contact_name"),
  postalCode: text("postal_code"),
  city: text("city"),
  country: text("country"),
  billingEmail: text("billing_email"),
  billingAddress: text("billing_address"),
  notes: text("notes"),
  unavailablePeriods: jsonb("unavailable_periods")
    .$type<CustomerUnavailablePeriod[]>()
    .notNull()
    .default([]),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
});

export const insertCustomerSchema = createInsertSchema(customersTable).omit({ id: true, createdAt: true, archivedAt: true });
export type InsertCustomer = z.infer<typeof insertCustomerSchema>;
export type Customer = typeof customersTable.$inferSelect;
