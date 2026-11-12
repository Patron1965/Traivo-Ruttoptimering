import { pgTable, uuid, text, timestamp, boolean, integer, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export const shopifyIntegrationsTable = pgTable("shopify_integrations", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }).notNull().unique(),
  shopDomain: text("shop_domain").notNull(),
  accessToken: text("access_token").notNull(),
  isActive: boolean("is_active").notNull().default(true),
  lastSyncAt: timestamp("last_sync_at"),
  totalOrdersImported: integer("total_orders_imported").notNull().default(0),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("shopify_integrations_org_id_idx").on(table.organizationId),
]);

export const shopifyImportLogsTable = pgTable("shopify_import_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id, { onDelete: "cascade" }).notNull(),
  ordersFound: integer("orders_found").notNull().default(0),
  ordersImported: integer("orders_imported").notNull().default(0),
  ordersSkipped: integer("orders_skipped").notNull().default(0),
  errors: text("errors"),
  importedAt: timestamp("imported_at").defaultNow().notNull(),
}, (table) => [
  index("shopify_import_logs_org_id_idx").on(table.organizationId),
]);

export type ShopifyIntegration = typeof shopifyIntegrationsTable.$inferSelect;
export type InsertShopifyIntegration = typeof shopifyIntegrationsTable.$inferInsert;
export type ShopifyImportLog = typeof shopifyImportLogsTable.$inferSelect;
