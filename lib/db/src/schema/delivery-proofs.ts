import { pgTable, uuid, text, timestamp, index, uniqueIndex } from "drizzle-orm/pg-core";
import { stopsTable } from "./stops";

export const deliveryProofsTable = pgTable("delivery_proofs", {
  id: uuid("id").defaultRandom().primaryKey(),
  stopId: uuid("stop_id").references(() => stopsTable.id, { onDelete: "cascade" }).notNull(),
  proofType: text("proof_type").notNull(),
  /** "pickup" for PoP evidence, "delivery" for PoD evidence (default for all legacy rows) */
  proofStage: text("proof_stage").notNull().default("delivery"),
  fileUrl: text("file_url"),
  data: text("data"),
  notes: text("notes"),
  clientEventId: text("client_event_id"),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("delivery_proofs_stop_id_idx").on(table.stopId),
  uniqueIndex("delivery_proofs_stop_client_event_unique").on(table.stopId, table.clientEventId),
]);

export type DeliveryProof = typeof deliveryProofsTable.$inferSelect;
export type InsertDeliveryProof = typeof deliveryProofsTable.$inferInsert;
