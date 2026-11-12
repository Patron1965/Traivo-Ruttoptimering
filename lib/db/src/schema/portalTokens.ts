import { pgTable, uuid, text, timestamp, index } from "drizzle-orm/pg-core";
import { portalAccountsTable } from "./portalAccounts";
import { createInsertSchema } from "drizzle-zod";

export const portalTokensTable = pgTable("portal_tokens", {
  hash: text("hash").primaryKey(),
  accountId: uuid("account_id").notNull().references(() => portalAccountsTable.id, { onDelete: "cascade" }),
  purpose: text("purpose").$type<"session" | "reset" | "login">().notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
}, t => [index("portal_tokens_account_idx").on(t.accountId)]);
export const insertPortalTokenSchema = createInsertSchema(portalTokensTable);
