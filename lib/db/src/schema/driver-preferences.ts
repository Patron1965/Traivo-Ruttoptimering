import { pgTable, uuid, real, integer, boolean, time, index } from "drizzle-orm/pg-core";
import { driversTable } from "./drivers";

export const driverPreferencesTable = pgTable("driver_preferences", {
  id: uuid("id").defaultRandom().primaryKey(),
  driverId: uuid("driver_id").references(() => driversTable.id, { onDelete: "cascade" }).notNull().unique(),
  preferredStartTime: time("preferred_start_time").default("07:00:00"),
  preferredEndTime: time("preferred_end_time").default("16:00:00"),
  maxDrivingHoursPerDay: real("max_driving_hours_per_day").notNull().default(8),
  breakFrequencyMinutes: integer("break_frequency_minutes").notNull().default(120),
  preferredBreakDurationMin: integer("preferred_break_duration_min").notNull().default(15),
  avoidNightDriving: boolean("avoid_night_driving").notNull().default(false),
  happinessScore: real("happiness_score").notNull().default(0.5),
}, (table) => [
  index("driver_preferences_driver_id_idx").on(table.driverId),
]);

export type DriverPreferences = typeof driverPreferencesTable.$inferSelect;
export type InsertDriverPreferences = typeof driverPreferencesTable.$inferInsert;
