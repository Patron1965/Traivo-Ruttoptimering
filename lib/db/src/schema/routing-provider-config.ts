import { pgTable, text, timestamp, uuid } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

/** An absent row or null server_id inherits the operator-managed shared server. */
export const organizationRoutingProvidersTable = pgTable("organization_routing_providers", {
  organizationId: uuid("organization_id").primaryKey()
    .references(() => organizationsTable.id, { onDelete: "cascade" }),
  serverId: text("server_id"),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

export const insertOrganizationRoutingProviderSchema = createInsertSchema(organizationRoutingProvidersTable);
export type InsertOrganizationRoutingProvider = z.infer<typeof insertOrganizationRoutingProviderSchema>;
export type OrganizationRoutingProvider = typeof organizationRoutingProvidersTable.$inferSelect;