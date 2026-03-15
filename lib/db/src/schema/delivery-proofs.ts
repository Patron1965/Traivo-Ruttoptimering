import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { stopsTable } from "./stops";

export const deliveryProofsTable = pgTable("delivery_proofs", {
  id: uuid("id").defaultRandom().primaryKey(),
  stopId: uuid("stop_id").references(() => stopsTable.id, { onDelete: "cascade" }).notNull(),
  proofType: text("proof_type").notNull(),
  fileUrl: text("file_url"),
  data: text("data"),
  notes: text("notes"),
  capturedAt: timestamp("captured_at").defaultNow().notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("delivery_proofs_stop_id_idx").on(table.stopId),
]);

export type DeliveryProof = typeof deliveryProofsTable.$inferSelect;
export type InsertDeliveryProof = typeof deliveryProofsTable.$inferInsert;
