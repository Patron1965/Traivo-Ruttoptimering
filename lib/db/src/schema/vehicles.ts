import { pgTable, uuid, text, timestamp, real, boolean, pgEnum, index } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const vehicleTypeEnum = pgEnum("vehicle_type", ["fossil", "electric"]);

export const vehiclesTable = pgTable("vehicles", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  name: text("name").notNull(),
  licensePlate: text("license_plate").notNull(),
  vehicleType: vehicleTypeEnum("vehicle_type").notNull().default("fossil"),
  capacityKg: real("capacity_kg").notNull().default(1000),
  capacityVolume: real("capacity_volume").notNull().default(10),
  batteryCapacityKwh: real("battery_capacity_kwh"),
  currentBatteryPercent: real("current_battery_percent"),
  rangeKm: real("range_km"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("vehicles_organization_id_idx").on(table.organizationId),
]);

export const insertVehicleSchema = createInsertSchema(vehiclesTable).omit({ id: true, createdAt: true });
export type InsertVehicle = z.infer<typeof insertVehicleSchema>;
export type Vehicle = typeof vehiclesTable.$inferSelect;
