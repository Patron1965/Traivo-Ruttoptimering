import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

/**
 * Short-lived records created when a presigned upload URL is issued for a
 * document. Consumed (marked used) exactly once by POST /documents so that
 * the object path accepted from the client is always one we issued ourselves
 * to the same user + org.
 */
export const documentUploadIntentsTable = pgTable("document_upload_intents", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .references(() => organizationsTable.id, { onDelete: "cascade" })
    .notNull(),
  userId: uuid("user_id")
    .references(() => usersTable.id, { onDelete: "cascade" })
    .notNull(),
  objectPath: text("object_path").notNull(),
  name: text("name").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  expiresAt: timestamp("expires_at").notNull(),
  usedAt: timestamp("used_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  index("doc_upload_intents_org_idx").on(table.organizationId),
  index("doc_upload_intents_user_idx").on(table.userId),
]);

export type DocumentUploadIntent = typeof documentUploadIntentsTable.$inferSelect;
export type InsertDocumentUploadIntent = typeof documentUploadIntentsTable.$inferInsert;
