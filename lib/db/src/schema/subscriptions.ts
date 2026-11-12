import { pgTable, uuid, text, timestamp, integer, boolean, pgEnum } from "drizzle-orm/pg-core";
import { organizationsTable } from "./organizations";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const planTierEnum = pgEnum("plan_tier", ["starter", "pro", "enterprise"]);
export const subscriptionStatusEnum = pgEnum("subscription_status", ["trialing", "active", "past_due", "canceled", "paused"]);

export const subscriptionPlansTable = pgTable("subscription_plans", {
  id: uuid("id").defaultRandom().primaryKey(),
  tier: planTierEnum("tier").notNull().unique(),
  name: text("name").notNull(),
  description: text("description"),
  monthlyPriceOre: integer("monthly_price_ore").notNull().default(0),
  maxVehicles: integer("max_vehicles"),
  maxStopsPerMonth: integer("max_stops_per_month"),
  maxDrivers: integer("max_drivers"),
  featuresJson: text("features_json").notNull().default("[]"),
  isActive: boolean("is_active").notNull().default(true),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export const subscriptionsTable = pgTable("subscriptions", {
  id: uuid("id").defaultRandom().primaryKey(),
  organizationId: uuid("organization_id").notNull().references(() => organizationsTable.id),
  planId: uuid("plan_id").notNull().references(() => subscriptionPlansTable.id),
  status: subscriptionStatusEnum("status").notNull().default("trialing"),
  trialStartDate: timestamp("trial_start_date"),
  trialEndDate: timestamp("trial_end_date"),
  currentPeriodStart: timestamp("current_period_start"),
  currentPeriodEnd: timestamp("current_period_end"),
  cancelAtPeriodEnd: boolean("cancel_at_period_end").notNull().default(false),
  stopsUsedThisMonth: integer("stops_used_this_month").notNull().default(0),
  stopsResetAt: timestamp("stops_reset_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const insertSubscriptionPlanSchema = createInsertSchema(subscriptionPlansTable).omit({ id: true, createdAt: true });
export type InsertSubscriptionPlan = z.infer<typeof insertSubscriptionPlanSchema>;
export type SubscriptionPlan = typeof subscriptionPlansTable.$inferSelect;

export const insertSubscriptionSchema = createInsertSchema(subscriptionsTable).omit({ id: true, createdAt: true, updatedAt: true });
export type InsertSubscription = z.infer<typeof insertSubscriptionSchema>;
export type Subscription = typeof subscriptionsTable.$inferSelect;
