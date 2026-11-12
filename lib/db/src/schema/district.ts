import { pgTable, uuid, text, integer, doublePrecision, jsonb, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";

export const districtPlansTable = pgTable("district_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  name: text("name").notNull(),
  revision: integer("revision").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [index("district_plans_org_idx").on(t.organizationId)]);
export const districtImportsTable = pgTable("district_imports", {
  id: uuid("id").defaultRandom().primaryKey(),
  planId: uuid("plan_id").notNull().references(() => districtPlansTable.id),
  sourceKey: text("source_key").notNull(),
  payloadHash: text("payload_hash").notNull(),
  total: integer("total").notNull(),
  valid: integer("valid").notNull(),
  rejected: integer("rejected").notNull(),
  revision: integer("revision").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [uniqueIndex("district_import_source_idx").on(t.planId, t.sourceKey)]);
export const districtZonesTable = pgTable("district_zones", {
  id: uuid("id").defaultRandom().primaryKey(),
  planId: uuid("plan_id").notNull().references(() => districtPlansTable.id),
  name: text("name").notNull(),
  color: text("color").notNull(),
  polygon: jsonb("polygon").$type<{lat:number,lng:number}[]>(),
  revision: integer("revision").notNull().default(0),
  deletedAt: timestamp("deleted_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
}, t => [index("district_zones_plan_idx").on(t.planId)]);
export const districtPointsTable = pgTable("district_points", {
  id: uuid("id").defaultRandom().primaryKey(),
  planId: uuid("plan_id").notNull().references(() => districtPlansTable.id),
  importId: uuid("import_id").notNull().references(() => districtImportsTable.id),
  sourceRowNumber: integer("source_row_number").notNull(),
  objectNumber: text("object_number").notNull(),
  address: text("address").notNull(),
  latitude: doublePrecision("latitude").notNull(),
  longitude: doublePrecision("longitude").notNull(),
  original: jsonb("original").$type<Record<string,string>>().notNull(),
  zoneId: uuid("zone_id").references(() => districtZonesTable.id),
}, t => [index("district_points_plan_idx").on(t.planId), index("district_points_zone_idx").on(t.zoneId), uniqueIndex("district_points_source_row_idx").on(t.importId, t.sourceRowNumber)]);
export type DistrictResult = {
  orderedPointIds: string[];
  distanceMeters: number;
  driveSeconds: number;
  geometry: {latitude:number,longitude:number}[];
  warnings: string[];
};
export type DistrictJobInput = {
  points: {id:string,latitude:number,longitude:number}[];
  mode: "loop"|"open";
  start: {pointId?:string,latitude?:number,longitude?:number};
  end?: {pointId?:string,latitude?:number,longitude?:number};
  serviceMinutes: number;
  bulk?: {
    engine:"bulk-road-v1";scope:"zone"|"plan";planRevision:number;intakeRevision:number|null;
    datasetIdentity:string;sourceHash:string;
    exceptions:{pointId:string;maxSnapMeters:number;reason:string}[];
    sourceRows:{id:string;pointId?:string;sourceRowNumber:number;objectNumber:string;original:Record<string,string>;status:string;reason:string}[];
  };
};
export const districtJobsTable = pgTable("district_jobs", {
  id: uuid("id").defaultRandom().primaryKey(),
  planId: uuid("plan_id").notNull().references(() => districtPlansTable.id),
  zoneId: uuid("zone_id").notNull().references(() => districtZonesTable.id),
  revision: integer("revision").notNull(),
  status: text("status").notNull().default("queued"),
  progress: integer("progress").notNull().default(0),
  input: jsonb("input").$type<DistrictJobInput>().notNull(),
  result: jsonb("result").$type<DistrictResult>(),
  error: text("error"),
  leaseUntil: timestamp("lease_until", {withTimezone:true}),
  attempts: integer("attempts").notNull().default(0),
  createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", {withTimezone:true}).defaultNow().notNull(),
}, t => [index("district_jobs_plan_idx").on(t.planId), index("district_jobs_claim_idx").on(t.status,t.leaseUntil)]);
export type DistrictSnapshotRow = {pointId:string,objectNumber:string,sourceRowNumber:number,routeOrder:number,exportOrder:number,original:Record<string,string>;
  sourceStatus?:string;reason?:string;datasetIdentity?:string;distanceException?:string};
export const districtExportsTable = pgTable("district_exports", {
  id: uuid("id").defaultRandom().primaryKey(),
  planId: uuid("plan_id").notNull().references(() => districtPlansTable.id),
  jobId: uuid("job_id").notNull().references(() => districtJobsTable.id),
  actorId: uuid("actor_id").notNull(),
  columns: jsonb("columns").$type<string[]>().notNull(),
  rows: jsonb("rows").$type<DistrictSnapshotRow[]>().notNull(),
  createdAt: timestamp("created_at", {withTimezone:true}).defaultNow().notNull(),
}, t => [index("district_exports_plan_idx").on(t.planId)]);
export const insertDistrictPlanSchema = createInsertSchema(districtPlansTable).omit({id:true,revision:true,createdAt:true});
export type InsertDistrictPlan = z.infer<typeof insertDistrictPlanSchema>;
export type DistrictPlan = typeof districtPlansTable.$inferSelect;