import { pgTable, uuid, text, timestamp, jsonb, index } from "drizzle-orm/pg-core";

export const auditLogTable = pgTable(
  "audit_log",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id"),
    userId: uuid("user_id"),
    userEmail: text("user_email"),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    method: text("method").notNull(),
    path: text("path").notNull(),
    statusCode: text("status_code"),
    requestId: text("request_id"),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    diff: jsonb("diff"),
    metadata: jsonb("metadata"),
    createdAt: timestamp("created_at").defaultNow().notNull(),
  },
  (table) => ({
    orgTimeIdx: index("audit_log_org_time_idx").on(table.organizationId, table.createdAt),
    resourceIdx: index("audit_log_resource_idx").on(table.resourceType, table.resourceId),
    userIdx: index("audit_log_user_idx").on(table.userId, table.createdAt),
  }),
);

export type AuditLogEntry = typeof auditLogTable.$inferSelect;
export type InsertAuditLogEntry = typeof auditLogTable.$inferInsert;
