export type DriverExecutionStatus = "completed" | "failed" | "skipped";

interface DriverExecutionRequestOptions {
  apiBase: string;
  stopId: string;
  status: DriverExecutionStatus;
  planVersion: number;
  clientEventId: string;
  occurredAt: string;
  details?: {
    skipReason?: string;
    comment?: string;
  };
}

export function buildDriverExecutionRequest({
  apiBase,
  stopId,
  status,
  planVersion,
  clientEventId,
  occurredAt,
  details = {},
}: DriverExecutionRequestOptions): { url: string; init: RequestInit } {
  return {
    url: `${apiBase}/api/stops/${encodeURIComponent(stopId)}/execution-events`,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clientEventId,
        type: status,
        planVersion,
        occurredAt,
        ...details,
      }),
    },
  };
}