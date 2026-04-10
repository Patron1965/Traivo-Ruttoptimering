import { pgTable, uuid, text, timestamp, boolean, index, real, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { vehiclesTable } from "./vehicles";

export const driverTempoEnum = pgEnum("driver_tempo", ["slow", "normal", "fast"]);

export const driversTable = pgTable("drivers", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").references(() => organizationsTable.id).notNull(),
  name: text("name").notNull(),
  phone: text("phone"),
  email: text("email"),
  vehicleId: uuid("vehicle_id").references(() => vehiclesTable.id),
  isActive: boolean("is_active").notNull().default(true),
  workStartTime: text("work_start_time"),
  workEndTime: text("work_end_time"),
  tempo: driverTempoEnum("tempo").default("normal"),
  capacityKg: real("capacity_kg"),
  capacityVolume: real("capacity_volume"),
  startAddress: text("start_address"),
  startLatitude: real("start_latitude"),
  startLongitude: real("start_longitude"),
  endAddress: text("end_address"),
  endLatitude: real("end_latitude"),
  endLongitude: real("end_longitude"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("drivers_organization_id_idx").on(table.organizationId),
  index("drivers_vehicle_id_idx").on(table.vehicleId),
  index("drivers_is_active_idx").on(table.isActive),
]);

export const insertDriverSchema = createInsertSchema(driversTable).omit({ id: true, createdAt: true });
export type InsertDriver = z.infer<typeof insertDriverSchema>;
export type Driver = typeof driversTable.$inferSelect;
