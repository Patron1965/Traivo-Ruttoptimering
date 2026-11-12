import { pgTable, uuid, integer, text, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { districtPlansTable } from "./district";

export type DistrictIntakeRow = {
  sourceRowNumber: number;
  original: Record<string,string>;
  objectNumber: string;
  address: string;
  status: "ready"|"unresolved"|"rejected";
  reason: string;
  latitude?: number;
  longitude?: number;
  pointId?: string;
  candidates?: {latitude:number,longitude:number,displayName:string}[];
};
export const districtIntakesTable=pgTable("district_intakes",{
  id:uuid("id").defaultRandom().primaryKey(),
  planId:uuid("plan_id").notNull().references(()=>districtPlansTable.id),
  sourceKey:text("source_key").notNull(),
  payloadHash:text("payload_hash").notNull(),
  sourceDraftId:uuid("source_draft_id"),
  sourceDraftRevision:integer("source_draft_revision"),
  revision:integer("revision").notNull().default(0),
  rows:jsonb("rows").$type<DistrictIntakeRow[]>().notNull(),
},t=>[uniqueIndex("district_intakes_plan_idx").on(t.planId)]);