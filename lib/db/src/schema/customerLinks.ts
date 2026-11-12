import { pgTable, uuid, text, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { stopsTable } from "./stops";

// Never spread this record into a stop/API response. The salt is recoverable
// only with the server secret; the public verifier is a one-way SHA-256 hash.
export const customerLinksTable = pgTable("customer_links", {
  stopId: uuid("stop_id").primaryKey().references(() => stopsTable.id, { onDelete: "cascade" }),
  routeId: uuid("route_id"),
  salt: text("salt").notNull(),
  tokenHash: text("token_hash").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  /** Earliest observed terminal deadline survives reopening and replacement. */
  terminalExpiresAt: timestamp("terminal_expires_at", { withTimezone: true }),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
}, (table) => [uniqueIndex("customer_links_token_hash_idx").on(table.tokenHash)]);