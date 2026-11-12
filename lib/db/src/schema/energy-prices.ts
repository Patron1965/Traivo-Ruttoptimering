import { pgTable, uuid, text, real, timestamp, uniqueIndex } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const energyPricesTable = pgTable("energy_prices", {
  id: uuid("id").defaultRandom().primaryKey(),
  priceArea: text("price_area").notNull(),
  timestamp: timestamp("timestamp").notNull(),
  priceEurMwh: real("price_eur_mwh").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (table) => [
  uniqueIndex("energy_prices_area_timestamp_idx").on(table.priceArea, table.timestamp),
]);

export const insertEnergyPriceSchema = createInsertSchema(energyPricesTable).omit({ id: true, createdAt: true });
export type InsertEnergyPrice = z.infer<typeof insertEnergyPriceSchema>;
export type EnergyPrice = typeof energyPricesTable.$inferSelect;
