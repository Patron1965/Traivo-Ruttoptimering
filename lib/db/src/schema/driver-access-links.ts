import { pgTable, uuid, text, timestamp, integer, uniqueIndex } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { driversTable } from "./drivers";
import { routesTable } from "./routes";

export const driverAccessLinksTable = pgTable("driver_access_links", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  driverId: uuid("driver_id").notNull().references(() => driversTable.id, { onDelete: "cascade" }),
  routeId: uuid("route_id").notNull().references(() => routesTable.id, { onDelete: "cascade" }),
  tokenHash: text("token_hash").notNull(),
  vehicleId: uuid("vehicle_id").notNull(),
  phoneHash: text("phone_hash").notNull(),
  accessVersion: integer("access_version").notNull(),
  routeVersion: integer("route_version").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  consumedAt: timestamp("consumed_at"),
  createdAt: timestamp("created_at").notNull().defaultNow(),
}, table => [uniqueIndex("driver_access_links_token_idx").on(table.tokenHash)]);
