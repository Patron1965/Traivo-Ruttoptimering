import { createAppError } from "./error-localizer.ts";

interface WorkExecutionPort {
  getRoute: (routeId: string) => Promise<{
    status: string;
    handoffStatus?: string | null;
    planRevision?: number | null;
    handoffVersion?: number | null;
  }>;
  getExecution: (routeId: string) => Promise<{ status: string } | null>;
  start: (routeId: string, action: "start", clientEventId: string, occurredAt?: string) => Promise<unknown>;
}

/** Start work through the existing route lifecycle, independently of device GPS. */
export async function ensureWorkExecution(
  routeId: string,
  planVersion: number,
  port: WorkExecutionPort,
  occurredAt?: string,
): Promise<void> {
  const route = await port.getRoute(routeId);
  if (route.planRevision !== planVersion || route.handoffVersion !== planVersion
    || route.handoffStatus !== "accepted"
    || route.status === "completed" || route.status === "cancelled") {
    throw createAppError("conflict");
  }
  if ((await port.getExecution(routeId))?.status === "active") return;
  await port.start(routeId, "start", `work-start:${routeId}:${planVersion}`, occurredAt);
}

/** A rejected action is not an offline action and must not be silently queued. */
export function isRetryableWorkFailure(error: unknown): boolean {
  const status = (error as { status?: unknown } | null)?.status;
  return typeof status === "number" && (status === 0 || status >= 500);
}
