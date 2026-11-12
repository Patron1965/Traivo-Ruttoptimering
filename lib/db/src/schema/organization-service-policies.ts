import { pgTable, uuid, jsonb, integer, timestamp } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export interface OrganizationServicePolicy {
  /** Requested service only; activation requires a verified tenant-bound connection. */
  preferredLoginService?: "password" | "siths";
  roadProvider: "inherit" | "disabled" | "osrm" | "geoapify";
  geocodingProvider: "inherit" | "disabled" | "google" | "nominatim";
  smsProvider: "inherit" | "disabled" | "linkmobility" | "twilio" | "46elks";
  emailEnabled: boolean;
  aiEnabled: boolean;
  cuoptEnabled: boolean;
  districtEnabled: boolean;
}

export const organizationServicePoliciesTable = pgTable("organization_service_policies", {
  organizationId: uuid("organization_id").primaryKey().references(() => organizationsTable.id, { onDelete: "cascade" }),
  policy: jsonb("policy").$type<OrganizationServicePolicy>().notNull(),
  revision: integer("revision").notNull().default(1),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
