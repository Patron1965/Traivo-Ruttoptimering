import { pgTable, uuid, text, integer, timestamp, jsonb, uniqueIndex } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";

export type CustomerVisitIdempotencyResult = {
  draftId?: string;
  planId?: string;
  stopIds: string[];
  count: number;
};

export const customerVisitIdempotencyTable = pgTable(
  "customer_visit_idempotency",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id)
      .notNull(),
    idempotencyKey: text("idempotency_key").notNull(),
    payloadHash: text("payload_hash").notNull(),
    result: jsonb("result").$type<CustomerVisitIdempotencyResult>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    uniqueIndex("customer_visit_idempotency_org_key_unique").on(
      table.organizationId,
      table.idempotencyKey,
    ),
  ],
);

export type CustomerVisitIdempotency = typeof customerVisitIdempotencyTable.$inferSelect;