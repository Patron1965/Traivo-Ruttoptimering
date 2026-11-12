import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";
import { organizationsTable } from "./organizations";
import { routesTable } from "./routes";
import { stopsTable } from "./stops";
import { driversTable } from "./drivers";
import { usersTable } from "./users";

export const stopMessageThreadsTable = pgTable(
  "stop_message_threads",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id, { onDelete: "cascade" })
      .notNull(),
    routeId: uuid("route_id")
      .references(() => routesTable.id, { onDelete: "cascade" })
      .notNull(),
    stopId: uuid("stop_id")
      .references(() => stopsTable.id, { onDelete: "cascade" })
      .notNull(),
    driverId: uuid("driver_id")
      .references(() => driversTable.id)
      .notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("stop_message_threads_org_stop_uidx").on(
      table.organizationId,
      table.stopId,
    ),
    index("stop_message_threads_org_route_idx").on(
      table.organizationId,
      table.routeId,
    ),
  ],
);

export const stopMessagesTable = pgTable(
  "stop_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id, { onDelete: "cascade" })
      .notNull(),
    threadId: uuid("thread_id")
      .references(() => stopMessageThreadsTable.id, { onDelete: "cascade" })
      .notNull(),
    senderUserId: uuid("sender_user_id")
      .references(() => usersTable.id)
      .notNull(),
    senderRole: text("sender_role").notNull(),
    clientMessageId: text("client_message_id").notNull(),
    body: text("body").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("stop_messages_org_client_id_uidx").on(
      table.organizationId,
      table.clientMessageId,
    ),
    index("stop_messages_thread_created_idx").on(
      table.threadId,
      table.createdAt,
    ),
    index("stop_messages_org_created_idx").on(
      table.organizationId,
      table.createdAt,
    ),
  ],
);

export const stopMessageReadReceiptsTable = pgTable(
  "stop_message_read_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id, { onDelete: "cascade" })
      .notNull(),
    messageId: uuid("message_id")
      .references(() => stopMessagesTable.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => usersTable.id, { onDelete: "cascade" })
      .notNull(),
    readAt: timestamp("read_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("stop_message_read_receipts_message_user_uidx").on(
      table.messageId,
      table.userId,
    ),
    index("stop_message_read_receipts_org_user_idx").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export const insertStopMessageSchema = createInsertSchema(stopMessagesTable).omit({
  id: true,
  createdAt: true,
});
export type InsertStopMessage = z.infer<typeof insertStopMessageSchema>;
export type StopMessage = typeof stopMessagesTable.$inferSelect;
export type StopMessageThread = typeof stopMessageThreadsTable.$inferSelect;
export type StopMessageReadReceipt = typeof stopMessageReadReceiptsTable.$inferSelect;