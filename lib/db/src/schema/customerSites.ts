import {
  pgEnum,
  pgTable,
  uuid,
  text,
  real,
  integer,
  timestamp,
  jsonb,
  index,
  boolean,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { customersTable } from "./customers";
import { organizationsTable } from "./organizations";

export const customerSiteVerificationStatusEnum = pgEnum(
  "customer_site_verification_status",
  ["exact", "candidate"],
);

export type CustomerSiteVerificationMetadata = {
  provider: "google" | "nominatim";
  source: "google" | "nominatim" | "cache";
  displayName: string;
  query: string;
  candidateId?: string;
};

export const customerSitesTable = pgTable(
  "customer_sites",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id)
      .notNull(),
    customerId: uuid("customer_id")
      .references(() => customersTable.id)
      .notNull(),
    name: text("name").notNull(),
    /** The unmodified address entered by the dispatcher. */
    addressInput: text("address_input").notNull(),
    /** Provider's canonical display address used for navigation. */
    address: text("address").notNull(),
    latitude: real("latitude").notNull(),
    longitude: real("longitude").notNull(),
    verificationStatus: customerSiteVerificationStatusEnum("verification_status").notNull(),
    verificationMetadata: jsonb("verification_metadata").$type<CustomerSiteVerificationMetadata>().notNull(),
    contactName: text("contact_name"),
    contactPhone: text("contact_phone"),
    contactEmail: text("contact_email"),
    windowStart: text("window_start"),
    windowEnd: text("window_end"),
    serviceDurationMin: integer("service_duration_min").notNull().default(5),
    isPrioritized: boolean("is_prioritized").notNull().default(false),
    instructions: text("instructions"),
    revision: integer("revision").notNull().default(0),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    index("customer_sites_org_customer_idx").on(table.organizationId, table.customerId),
    index("customer_sites_org_archived_idx").on(table.organizationId, table.archivedAt),
  ],
);

export const insertCustomerSiteSchema = createInsertSchema(customerSitesTable).omit({
  id: true,
  createdAt: true,
  updatedAt: true,
});
export type InsertCustomerSite = z.infer<typeof insertCustomerSiteSchema>;
export type CustomerSite = typeof customerSitesTable.$inferSelect;