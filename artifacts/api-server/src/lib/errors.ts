import type { Response } from "express";
import { OrgScopeError } from "../middleware/auth";
import { PlatformMfaUnavailableError } from "./platform-mfa";
import { RoadDataUnavailableError } from "../services/road-data-policy";
import { OrganizationServicePolicyError } from "../services/organization-service-policy";

export function handleError(res: Response, err: unknown): void {
  if (err instanceof OrganizationServicePolicyError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof RoadDataUnavailableError) {
    res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  if (err instanceof PlatformMfaUnavailableError) {
    res.status(503).json({ error: err.message, code: err.code });
    return;
  }
  const dbError = err instanceof Error && "cause" in err ? err.cause : err;
  if (dbError instanceof Error && dbError.message.startsWith("PLANNING_LOCK_CONFLICT:")) {
    res.status(409).json({
      error: dbError.message.slice("PLANNING_LOCK_CONFLICT:".length).trim(),
      code: "PLANNING_LOCK_CONFLICT",
    });
    return;
  }
  if (dbError && typeof dbError === "object" && "code" in dbError &&
      dbError.code === "23505" && "constraint" in dbError && dbError.constraint === "users_login_email_unique") {
    res.status(409).json({ error: "E-postadressen används redan av ett konto" });
    return;
  }
  if (err instanceof OrgScopeError) {
    res.status(err.statusCode).json({ error: err.message });
    return;
  }
  if (err instanceof Error && err.name === "ZodError" && "issues" in err) {
    const zodErr = err as Error & { issues: unknown[] };
    res.status(400).json({ error: "Validation error", details: zodErr.issues });
    return;
  }
  if (
    err instanceof Error &&
    "statusCode" in err &&
    typeof (err as Error & { statusCode?: unknown }).statusCode === "number"
  ) {
    const statusCode = (err as Error & { statusCode: number }).statusCode;
    if (statusCode >= 400 && statusCode <= 599) {
      res.status(statusCode).json({ error: err.message });
      return;
    }
  }
  if (err instanceof Error) {
    res.status(400).json({ error: err.message });
    return;
  }
  res.status(500).json({ error: "Internal server error" });
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseUuidParam(params: Record<string, string | string[]>): { id: string } {
  const id = params.id;
  if (typeof id !== "string" || !UUID_REGEX.test(id)) {
    throw new Error("Invalid UUID parameter");
  }
  return { id };
}
