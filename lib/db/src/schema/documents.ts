import { pgTable, uuid, text, integer, timestamp, index } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { usersTable } from "./users";

export const documentsTable = pgTable("documents", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id")
    .references(() => organizationsTable.id, { onDelete: "cascade" })
    .notNull(),
  uploadedBy: uuid("uploaded_by")
    .references(() => usersTable.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  fileUrl: text("file_url").notNull(),
  contentType: text("content_type").notNull(),
  sizeBytes: integer("size_bytes").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (table) => [
  index("documents_org_id_idx").on(table.organizationId),
  index("documents_uploaded_by_idx").on(table.uploadedBy),
]);

export type Document = typeof documentsTable.$inferSelect;
export type InsertDocument = typeof documentsTable.$inferInsert;
