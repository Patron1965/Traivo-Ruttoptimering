import { pgTable, uuid, text, timestamp, boolean, integer, real, jsonb, pgEnum } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod/v4";

export const orgOperatingModeEnum = pgEnum("org_operating_mode", ["transport", "field_service", "mixed"]);

export const organizationsTable = pgTable("organizations", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull(),
  archivedAt: timestamp("archived_at", { withTimezone: true }),
  email: text("email").notNull(),
  reportCategories: jsonb("report_categories").$type<{
    revision: number;
    categories: Array<{ id: string; label: string; active: boolean }>;
  }>().notNull().default({ revision: 0, categories: [] }),
  companyDetails: jsonb("company_details").$type<{
    registrationNumber?: string | null; contactPerson?: string | null; phone?: string | null;
    street?: string | null; postalCode?: string | null; city?: string | null;
    country?: string | null; invoiceEmail?: string | null;
  }>(),
  operatingMode: orgOperatingModeEnum("operating_mode").notNull().default("transport"),
  autoBalance: boolean("auto_balance").default(false),
  snapToRoad: boolean("snap_to_road").default(false),
  defaultRouteType: text("default_route_type").default("delivery"),
  maxDriverOvertimeMin: integer("max_driver_overtime_min").default(0),
  allowLateStopsMin: integer("allow_late_stops_min").default(0),
  defaultServiceDurationMin: integer("default_service_duration_min").default(5),
  customerSupportType: text("customer_support_type").default("customer_service"),
  notifyOrderCreated: boolean("notify_order_created").default(false),
  notifyDriverEnRoute: boolean("notify_driver_en_route").default(true),
  notifyDelivered: boolean("notify_delivered").default(true),
  notifyFailed: boolean("notify_failed").default(true),
  notificationSenderType: text("notification_sender_type").default("customer_service"),
  notificationTemplate: text("notification_template"),
  customerNotifications: jsonb("customer_notifications"),
  /** Customer-facing web branding. `name` remains the legal organization name. */
  brandDisplayName: text("brand_display_name"),
  brandWebsiteUrl: text("brand_website_url"),
  brandLogoUrl: text("brand_logo_url"),
  brandLogoDarkUrl: text("brand_logo_dark_url"),
  brandPrimaryColor: text("brand_primary_color"),
  brandAccentColor: text("brand_accent_color"),
  brandBackgroundColor: text("brand_background_color"),
  brandTagline: text("brand_tagline"),
  trackingSubdomain: text("tracking_subdomain"),
  smsEnabled: boolean("sms_enabled").default(false),
  notifySmsApproaching: boolean("notify_sms_approaching").default(false),
  notifySmsDelivered: boolean("notify_sms_delivered").default(false),
  notifySmsFailed: boolean("notify_sms_failed").default(false),
  stopRetentionEnabled: boolean("stop_retention_enabled").notNull().default(false),
  stopRetentionDays: integer("stop_retention_days").notNull().default(30),
  /** Provider-verified addresses are required before a depot can be used by planning. */
  depotStartAddress: text("depot_start_address"),
  depotStartLatitude: real("depot_start_latitude"),
  depotStartLongitude: real("depot_start_longitude"),
  depotStartVerification: jsonb("depot_start_verification").$type<DepotVerificationMetadata>(),
  depotStartVerifiedAt: timestamp("depot_start_verified_at"),
  depotEndAddress: text("depot_end_address"),
  depotEndLatitude: real("depot_end_latitude"),
  depotEndLongitude: real("depot_end_longitude"),
  depotEndVerification: jsonb("depot_end_verification").$type<DepotVerificationMetadata>(),
  depotEndVerifiedAt: timestamp("depot_end_verified_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

export type DepotVerificationMetadata = {
  provider: "google" | "nominatim";
  source: "google" | "nominatim" | "cache";
  displayName: string;
  query: string;
};

export const insertOrganizationSchema = createInsertSchema(organizationsTable).omit({ id: true, createdAt: true });
export type InsertOrganization = z.infer<typeof insertOrganizationSchema>;
export type Organization = typeof organizationsTable.$inferSelect;
