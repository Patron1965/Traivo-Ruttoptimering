import type { Request } from "express";
import { db, auditLogTable } from "@workspace/db";
import { logger } from "./logger";
import { isResendId, type RecoveryEmailResult } from "../services/resend-email";

/** Platform-only entries have no tenant scope, email address, request or session identifiers. */
export async function logPlatformEmailEvent(userId: string | null, attemptId: string, result: RecoveryEmailResult | {
  outcome: "delivered" | "bounced" | "complained" | "delivery_delayed" | "failed" | "unconfirmed" | "unavailable";
  providerId: string;
}) {
  try {
    await db.insert(auditLogTable).values({
      organizationId: null, userId, userEmail: null,
      action: "platform.email_code." + result.outcome, resourceType: "auth",
      resourceId: attemptId, method: "SYSTEM", path: "/platform/email-code",
      statusCode: "httpStatus" in result ? String(result.httpStatus ?? "") : null,
      metadata: { attemptId, provider: "resend", outcome: result.outcome,
        ...(isResendId(result.providerId) ? { providerId: result.providerId } : {}) },
    });
  } catch {
    logger.error({}, "Could not persist platform email-code diagnostic");
  }
}

export function getClientIp(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.length > 0) {
    return forwarded.split(",")[0]?.trim() || null;
  }
  return req.ip || null;
}

export type SecurityAction = "login.success" | "login.failed" | "logout" |
  "driver.access.activated" | "driver.access.revoked" |
  "platform.password_only_test.login" |
  "platform.mfa.pending" | "platform.mfa.enroll_started" | "platform.mfa.verified" | "platform.mfa.failed";

export interface SecurityEventInput {
  req: Request;
  action: SecurityAction;
  statusCode: number;
  organizationId?: string | null;
  userId?: string | null;
  userEmail?: string | null;
  reason?: string | null;
}

/**
 * Append a security (authentication) event to the shared audit_log table.
 * Writes never include passwords or tokens — only identity + outcome metadata.
 * Logged separately from the audit middleware so /auth bodies are never persisted.
 */
export async function logSecurityEvent(input: SecurityEventInput): Promise<void> {
  try {
    await db.insert(auditLogTable).values({
      organizationId: input.organizationId ?? null,
      userId: input.userId ?? null,
      userEmail: input.userEmail ?? null,
      action: input.action,
      resourceType: "auth",
      resourceId: null,
      method: input.req.method,
      path: input.req.path,
      statusCode: String(input.statusCode),
      requestId: input.req.requestId ?? null,
      ipAddress: getClientIp(input.req),
      userAgent: input.req.headers["user-agent"] || null,
      diff: null,
      metadata: input.reason ? { reason: input.reason } : {},
    });
  } catch (err) {
    console.error("[SECURITY] Failed to write log:", (err as Error)?.message || err);
  }
}

export interface AdminEventInput {
  req: Request;
  action: string;
  resourceType: "user" | "user_group" | "organization";
  resourceId?: string | null;
  statusCode: number;
  diff?: Record<string, unknown> | null;
  reason?: string | null;
}

/**
 * Append an administrative change (user/role/group/org settings) to the shared
 * audit_log. Identity (who/when) is derived from the authenticated actor on
 * req.user; the `diff` captures what changed (old → new). resourceType maps the
 * entry to the "admin" category in the security-log UI. Never logs secrets.
 */
export async function logAdminEvent(input: AdminEventInput): Promise<void> {
  const actor = input.req.user;
  try {
    await db.insert(auditLogTable).values({
      organizationId: actor?.organizationId ?? null,
      userId: actor?.id ?? null,
      userEmail: actor?.email ?? null,
      action: input.action,
      resourceType: input.resourceType,
      resourceId: input.resourceId ?? null,
      method: input.req.method,
      path: input.req.path,
      statusCode: String(input.statusCode),
      requestId: input.req.requestId ?? null,
      ipAddress: getClientIp(input.req),
      userAgent: input.req.headers["user-agent"] || null,
      diff: input.diff ?? null,
      metadata: input.reason ? { reason: input.reason } : {},
    });
  } catch (err) {
    console.error("[ADMIN] Failed to write log:", (err as Error)?.message || err);
  }
}

/**
 * Persist a data-export audit entry before the download is sent. Unlike general
 * administration logging this intentionally propagates failures: a successful
 * export must never be delivered without a durable accountability record.
 */
export async function logExportEvent(input: AdminEventInput): Promise<void> {
  const actor = input.req.user;
  await db.insert(auditLogTable).values({
    organizationId: actor?.organizationId ?? null,
    userId: actor?.id ?? null,
    userEmail: actor?.email ?? null,
    action: input.action,
    resourceType: input.resourceType,
    resourceId: input.resourceId ?? null,
    method: input.req.method,
    path: input.req.path,
    statusCode: String(input.statusCode),
    requestId: input.req.requestId ?? null,
    ipAddress: getClientIp(input.req),
    userAgent: input.req.headers["user-agent"] || null,
    diff: input.diff ?? null,
    metadata: input.reason ? { reason: input.reason } : {},
  });
}

/**
 * Record a route SMS resend outcome without retaining the phone number,
 * provider response, message body, or any credential material.
 */
export async function logRouteSmsResendEvent(input: {
  req: Request;
  routeId: string | null;
  statusCode: number;
  code: string;
  outcome: string;
}): Promise<void> {
  const actor = input.req.user;
  try {
    await db.insert(auditLogTable).values({
      organizationId: actor?.organizationId ?? null,
      userId: actor?.id ?? null,
      userEmail: actor?.email ?? null,
      action: "route.sms_resend",
      resourceType: "route",
      resourceId: input.routeId,
      method: input.req.method,
      path: input.req.path,
      statusCode: String(input.statusCode),
      requestId: input.req.requestId ?? null,
      ipAddress: getClientIp(input.req),
      userAgent: input.req.headers["user-agent"] || null,
      diff: null,
      metadata: {
        code: input.code,
        outcome: input.outcome,
      },
    });
  } catch (error) {
    logger.warn(
      { error: error instanceof Error ? error.message : String(error) },
      "Failed to write route SMS resend audit event",
    );
  }
}

/**
 * Record a rejected file upload (failed type/size validation or flagged by the
 * malicious-content scan) in the shared audit_log so abuse is traceable.
 */
export async function logUploadRejected(
  req: Request,
  reason: string,
  resourceId?: string | null
): Promise<void> {
  const actor = req.user;
  try {
    await db.insert(auditLogTable).values({
      organizationId: actor?.organizationId ?? null,
      userId: actor?.id ?? null,
      userEmail: actor?.email ?? null,
      action: "upload.rejected",
      resourceType: "upload",
      resourceId: resourceId ?? null,
      method: req.method,
      path: req.path,
      statusCode: "400",
      requestId: req.requestId ?? null,
      ipAddress: getClientIp(req),
      userAgent: req.headers["user-agent"] || null,
      diff: null,
      metadata: { reason },
    });
  } catch (err) {
    console.error("[UPLOAD] Failed to write log:", (err as Error)?.message || err);
  }
}
