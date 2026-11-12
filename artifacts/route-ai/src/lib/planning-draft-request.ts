type PlanningDraftErrorPayload = {
  error?: string;
  code?: string;
  details?: unknown;
};

export class PlanningDraftRequestError extends Error {
  readonly status: number;
  readonly code?: string;
  readonly details?: unknown;
  readonly payload: PlanningDraftErrorPayload;

  constructor(
    message: string,
    status: number,
    payload: PlanningDraftErrorPayload,
  ) {
    super(message);
    this.name = "PlanningDraftRequestError";
    this.status = status;
    this.code = payload.code;
    this.details = payload.details;
    this.payload = payload;
  }
}

/**
 * Perform exactly one draft update request.
 *
 * A gateway response does not tell us whether the server committed the write.
 * Retrying with a revision read after that response can turn a concurrent
 * update into an overwrite, so callers must surface the failure instead.
 */
export async function updatePlanningDraftRequest<T>(
  id: string,
  data: unknown,
): Promise<T> {
  const response = await fetch(`/api/planning-drafts/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(data),
    credentials: "include",
  });

  if (response.ok) {
    return (await response.json()) as T;
  }

  const errorPayload = await response.json().catch(() => ({})) as PlanningDraftErrorPayload;
  const message = response.status === 409 && errorPayload.code === "DRAFT_REVISION_CONFLICT"
    ? "DRAFT_REVISION_CONFLICT"
    : errorPayload.error || errorPayload.code || "Failed to update draft";
  throw new PlanningDraftRequestError(message, response.status, errorPayload);
}