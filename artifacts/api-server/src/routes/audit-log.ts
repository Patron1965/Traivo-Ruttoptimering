import { Router, type IRouter, type Request } from "express";
import {
  and,
  eq,
  gte,
  lte,
  desc,
  sql,
  inArray,
  type SQL,
} from "drizzle-orm";
import { db, auditLogTable, type AuditLogEntry } from "@workspace/db";
import { requireAuth, requireRole } from "../middleware/auth";
import { handleError } from "../lib/errors";
import { toCsv } from "../lib/csv";
import { logExportEvent } from "../lib/security-log";

const router: IRouter = Router();

const AUTH_ACTIONS = ["login.success", "login.failed", "logout"];
const ADMIN_RESOURCES = ["user", "user_group", "organization"];

/**
 * Logs are append-only: this router exposes read + export only. There are
 * deliberately no create/update/delete endpoints for audit_log anywhere in
 * the API, which keeps the trail tamper-resistant at the application layer.
 */

function parseDate(value: unknown, inclusiveEndOfDay = false): Date | null {
  if (typeof value !== "string" || value.length === 0) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  if (inclusiveEndOfDay && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    d.setUTCHours(23, 59, 59, 999);
  }
  return d;
}

function buildWhere(req: Request): SQL | undefined {
  const orgId = req.user!.organizationId;
  const conds: SQL[] = [eq(auditLogTable.organizationId, orgId)];

  const from = parseDate(req.query.from);
  const to = parseDate(req.query.to, true);
  if (from) conds.push(gte(auditLogTable.createdAt, from));
  if (to) conds.push(lte(auditLogTable.createdAt, to));

  const userId = req.query.userId;
  if (typeof userId === "string" && userId.length > 0) {
    conds.push(eq(auditLogTable.userId, userId));
  }

  const action = req.query.action;
  if (typeof action === "string" && action.length > 0) {
    conds.push(eq(auditLogTable.action, action));
  }

  const category = req.query.category;
  if (category === "auth") {
    conds.push(inArray(auditLogTable.action, AUTH_ACTIONS));
  } else if (category === "admin") {
    conds.push(inArray(auditLogTable.resourceType, ADMIN_RESOURCES));
  } else if (category === "data") {
    conds.push(
      sql`${auditLogTable.resourceType} NOT IN ('auth', 'user', 'user_group', 'organization')`,
    );
  }

  return and(...conds);
}

function exportFilters(req: Request) {
  return {
    from: parseDate(req.query.from)?.toISOString() ?? null,
    to: parseDate(req.query.to, true)?.toISOString() ?? null,
    userId: typeof req.query.userId === "string" ? req.query.userId : null,
    action: typeof req.query.action === "string" ? req.query.action : null,
    category: typeof req.query.category === "string" ? req.query.category : null,
  };
}

function deriveCategory(row: AuditLogEntry): string {
  if (row.resourceType === "auth") return "auth";
  if (ADMIN_RESOURCES.includes(row.resourceType)) return "admin";
  return "data";
}

// Normalized outcome of the event, independent of the raw HTTP status code.
function deriveResult(row: AuditLogEntry): "success" | "failure" | "unknown" {
  const code = parseInt(String(row.statusCode ?? ""), 10);
  if (Number.isNaN(code)) return "unknown";
  return code >= 200 && code < 400 ? "success" : "failure";
}

function serialize(row: AuditLogEntry) {
  const metadata = (row.metadata ?? {}) as Record<string, unknown>;
  return {
    id: row.id,
    timestamp: row.createdAt.toISOString(),
    action: row.action,
    category: deriveCategory(row),
    result: deriveResult(row),
    resourceType: row.resourceType,
    resourceId: row.resourceId,
    userId: row.userId,
    userEmail: row.userEmail,
    ipAddress: row.ipAddress,
    userAgent: row.userAgent,
    method: row.method,
    path: row.path,
    statusCode: row.statusCode,
    reason: typeof metadata.reason === "string" ? metadata.reason : null,
    requestId: row.requestId,
  };
}

type SerializedLog = ReturnType<typeof serialize>;

const CSV_COLUMNS: Array<keyof SerializedLog> = [
  "timestamp",
  "action",
  "category",
  "result",
  "userEmail",
  "userId",
  "ipAddress",
  "userAgent",
  "method",
  "path",
  "statusCode",
  "resourceType",
  "resourceId",
  "reason",
  "requestId",
];

// List logs with filters + pagination (admin only).
router.get(
  "/audit-logs",
  requireAuth(),
  requireRole("admin"),
  async (req, res) => {
    try {
      const where = buildWhere(req);
      const limit = Math.min(
        Math.max(parseInt(String(req.query.limit ?? "50"), 10) || 50, 1),
        200,
      );
      const page = Math.max(parseInt(String(req.query.page ?? "1"), 10) || 1, 1);
      const offset = (page - 1) * limit;

      const [rows, [{ count }]] = await Promise.all([
        db
          .select()
          .from(auditLogTable)
          .where(where)
          .orderBy(desc(auditLogTable.createdAt))
          .limit(limit)
          .offset(offset),
        db
          .select({ count: sql<number>`count(*)::int` })
          .from(auditLogTable)
          .where(where),
      ]);

      res.json({
        logs: rows.map(serialize),
        total: count,
        page,
        limit,
      });
    } catch (err) {
      handleError(res, err);
    }
  },
);

// Export filtered logs as CSV or JSON (admin only).
router.get(
  "/audit-logs/export",
  requireAuth(),
  requireRole("admin"),
  async (req, res) => {
    try {
      const where = buildWhere(req);
      const format = req.query.format === "json" ? "json" : "csv";
      const rows = await db
        .select()
        .from(auditLogTable)
        .where(where)
        .orderBy(desc(auditLogTable.createdAt))
        .limit(50000);

      const serialized = rows.map(serialize);
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
      await logExportEvent({
        req,
        action: "org.audit_log_export",
        resourceType: "organization",
        resourceId: req.user!.organizationId,
        statusCode: 200,
        diff: {
          exportType: { to: "audit_log" },
          format: { to: format },
          filters: { to: exportFilters(req) },
          resultCount: { to: serialized.length },
        },
      });

      if (format === "json") {
        res.setHeader("Content-Type", "application/json; charset=utf-8");
        res.setHeader(
          "Content-Disposition",
          `attachment; filename="audit-logs-${stamp}.json"`,
        );
        res.send(JSON.stringify(serialized, null, 2));
        return;
      }

      res.setHeader("Content-Type", "text/csv; charset=utf-8");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="audit-logs-${stamp}.csv"`,
      );
      res.send(toCsv(serialized));
    } catch (err) {
      handleError(res, err);
    }
  },
);

export default router;
