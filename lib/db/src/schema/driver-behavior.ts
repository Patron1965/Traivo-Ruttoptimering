import { pgTable, uuid, real, integer, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";
import { driversTable } from "./drivers";

export const driverBehaviorLogsTable = pgTable("driver_behavior_logs", {
  id: uuid("id").defaultRandom().primaryKey(),
  driverId: uuid("driver_id").references(() => driversTable.id, { onDelete: "cascade" }).notNull(),
  routeId: uuid("route_id").notNull(),
  logDate: timestamp("log_date").defaultNow().notNull(),
  plannedDurationMin: real("planned_duration_min"),
  actualDurationMin: real("actual_duration_min"),
  plannedDistanceKm: real("planned_distance_km"),
  actualDistanceKm: real("actual_distance_km"),
  stopsCompleted: integer("stops_completed").notNull().default(0),
  stopsTotal: integer("stops_total").notNull().default(0),
  stopsFailed: integer("stops_failed").notNull().default(0),
  avgServiceDurationMin: real("avg_service_duration_min"),
  onTimeRate: real("on_time_rate"),
  breaksTaken: integer("breaks_taken").notNull().default(0),
  totalBreakMin: real("total_break_min").notNull().default(0),
  startedAt: timestamp("started_at"),
  finishedAt: timestamp("finished_at"),
  areaCenter: jsonb("area_center").$type<{ lat: number; lng: number }>(),
  weatherCondition: text("weather_condition"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("dbl_driver_id_idx").on(table.driverId),
  index("dbl_log_date_idx").on(table.logDate),
  index("dbl_route_id_idx").on(table.routeId),
]);

export const driverLearnedProfilesTable = pgTable("driver_learned_profiles", {
  id: uuid("id").defaultRandom().primaryKey(),
  driverId: uuid("driver_id").references(() => driversTable.id, { onDelete: "cascade" }).notNull().unique(),
  speedFactor: real("speed_factor").notNull().default(1.0),
  serviceDurationFactor: real("service_duration_factor").notNull().default(1.0),
  reliabilityScore: real("reliability_score").notNull().default(0.5),
  preferredAreas: jsonb("preferred_areas").$type<{ lat: number; lng: number; familiarity: number }[]>().default([]),
  avgBreakIntervalMin: real("avg_break_interval_min"),
  peakPerformanceHour: integer("peak_performance_hour"),
  dataPointCount: integer("data_point_count").notNull().default(0),
  lastUpdated: timestamp("last_updated").defaultNow().notNull(),
}, (table) => [
  index("dlp_driver_id_idx").on(table.driverId),
]);

export type DriverBehaviorLog = typeof driverBehaviorLogsTable.$inferSelect;
export type InsertDriverBehaviorLog = typeof driverBehaviorLogsTable.$inferInsert;
export type DriverLearnedProfile = typeof driverLearnedProfilesTable.$inferSelect;
export type InsertDriverLearnedProfile = typeof driverLearnedProfilesTable.$inferInsert;
