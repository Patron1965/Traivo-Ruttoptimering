export type DispatchMoveError = Error & {
  status?: number;
  data?: Record<string, unknown>;
};

export function createDispatchMoveError(
  status: number,
  message: string,
  data?: Record<string, unknown>,
): DispatchMoveError {
  const error = new Error(message) as DispatchMoveError;
  error.status = status;
  error.data = data;
  return error;
}

export function getDispatchMoveErrorStatus(error: unknown): number | undefined {
  if (!error || typeof error !== "object") return undefined;
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : undefined;
}

export function isDispatchMoveUnauthorized(error: unknown): boolean {
  return getDispatchMoveErrorStatus(error) === 401;
}

/**
 * A revision conflict is safe to recover from by refreshing displayed data,
 * but the rejected drag must never be replayed automatically.
 */
export function isDispatchMoveRevisionConflict(error: unknown): boolean {
  if (getDispatchMoveErrorStatus(error) !== 409) return false;
  const data = error && typeof error === "object"
    ? (error as { data?: unknown }).data
    : undefined;
  return Boolean(
    data
    && typeof data === "object"
    && (data as { code?: unknown }).code === "DISPATCH_REVISION_CONFLICT",
  );
}