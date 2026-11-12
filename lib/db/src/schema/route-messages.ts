import {
  index,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { routesTable } from "./routes";
import { usersTable } from "./users";

export const routeMessagesTable = pgTable(
  "route_messages",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id, { onDelete: "cascade" })
      .notNull(),
    routeId: uuid("route_id")
      .references(() => routesTable.id, { onDelete: "cascade" })
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
    uniqueIndex("route_messages_org_client_id_uidx").on(
      table.organizationId,
      table.clientMessageId,
    ),
    index("route_messages_route_created_idx").on(
      table.organizationId,
      table.routeId,
      table.createdAt,
    ),
  ],
);

export const routeMessageReadReceiptsTable = pgTable(
  "route_message_read_receipts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id")
      .references(() => organizationsTable.id, { onDelete: "cascade" })
      .notNull(),
    messageId: uuid("message_id")
      .references(() => routeMessagesTable.id, { onDelete: "cascade" })
      .notNull(),
    userId: uuid("user_id")
      .references(() => usersTable.id, { onDelete: "cascade" })
      .notNull(),
    readAt: timestamp("read_at", { withTimezone: true })
      .defaultNow()
      .notNull(),
  },
  (table) => [
    uniqueIndex("route_message_receipts_message_user_uidx").on(
      table.messageId,
      table.userId,
    ),
    index("route_message_receipts_org_user_idx").on(
      table.organizationId,
      table.userId,
    ),
  ],
);

export type RouteMessage = typeof routeMessagesTable.$inferSelect;
export type RouteMessageReadReceipt = typeof routeMessageReadReceiptsTable.$inferSelect;