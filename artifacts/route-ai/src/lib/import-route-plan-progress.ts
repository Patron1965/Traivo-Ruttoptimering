import { useCallback, useEffect, useRef, useState } from "react";
import {
  createImportRoutePlan,
  type ImportRoutePlanInput,
  type ImportRoutePlanResult,
} from "@workspace/api-client-react";
import {
  getProgressElapsedMs,
  isCompleteProgressPayload,
  isProgressRecordForRun,
  isFreshProgressRecord,
  missingProgressStatus,
  isDefinitivePlanRejection,
  shouldSurfacePollAbort,
} from "./import-route-plan-progress-state";
export {
  getProgressElapsedMs,
  isCompleteProgressPayload,
  isProgressRecordForRun,
  isFreshProgressRecord,
  shouldSurfacePollAbort,
} from "./import-route-plan-progress-state";

export type ImportRoutePlanProgressPhase =
  | "preparing"
  | "distance_matrix"
  | "clustering"
  | "optimizing"
  | "merging"
  | "saving"
  | "complete";

export type ImportRoutePlanProgressStatus =
  | "starting"
  | "running"
  | "reconnecting"
  | "error"
  | "complete";

export type ImportRoutePlanProgressError = {
  code: string;
  message: string;
  details?: unknown;
};

export type ImportRoutePlanProgressRecord = {
  progressId: string;
  draftId?: string | null;
  status: "running" | "complete" | "error";
  phase: ImportRoutePlanProgressPhase;
  startedAt: string;
  updatedAt: string;
  serverNow: string;
  elapsedMs: number;
  progress?: Record<string, unknown> | null;
  estimatedRemainingMs: number | null;
  error: ImportRoutePlanProgressError | null;
  result: ImportRoutePlanResult | null;
};

export type ImportRoutePlanMonitorState = {
  progressId: string | null;
  status: ImportRoutePlanProgressStatus;
  phase: ImportRoutePlanProgressPhase;
  startedAt: string | null;
  elapsedMs: number | null;
  progress: Record<string, unknown> | null;
  estimatedRemainingMs: number | null;
  error: ImportRoutePlanProgressError | null;
  result: ImportRoutePlanResult | null;
  recordVisible: boolean;
};

export type ImportRoutePlanMonitorScope = {
  organizationId: string;
  userId: string;
  draftId: string;
};

type StoredProgress = {
  progressId: string;
};

const POLL_INTERVAL_MS = 2_000;
const REQUEST_TIMEOUT_MS = 8_000;

const emptyState: ImportRoutePlanMonitorState = {
  progressId: null,
  status: "running",
  phase: "preparing",
  startedAt: null,
  elapsedMs: null,
  progress: null,
  estimatedRemainingMs: null,
  error: null,
  result: null,
  recordVisible: false,
};

function apiPath(path: string): string {
  const base = import.meta.env.BASE_URL.replace(/\/$/, "");
  return `${base}/api${path}`;
}

function storageKey(scope: ImportRoutePlanMonitorScope): string {
  return [
    "traivo:import-route-plan-progress",
    encodeURIComponent(scope.organizationId),
    encodeURIComponent(scope.userId),
    encodeURIComponent(scope.draftId),
  ].join(":");
}

function readStoredProgress(scope?: ImportRoutePlanMonitorScope): string | null {
  if (!scope || typeof sessionStorage === "undefined") return null;
  try {
    const raw = sessionStorage.getItem(storageKey(scope));
    if (!raw) return null;
    const parsed = JSON.parse(raw) as StoredProgress;
    return typeof parsed.progressId === "string" && parsed.progressId
      ? parsed.progressId
      : null;
  } catch {
    return null;
  }
}

function writeStoredProgress(
  scope: ImportRoutePlanMonitorScope | undefined,
  progressId: string,
): void {
  if (!scope || typeof sessionStorage === "undefined") return;
  try {
    sessionStorage.setItem(
      storageKey(scope),
      JSON.stringify({ progressId } satisfies StoredProgress),
    );
  } catch {
    // Session storage is a recovery aid, not a reason to block planning.
  }
}

function clearStoredProgress(
  scope: ImportRoutePlanMonitorScope | undefined,
  progressId: string,
): void {
  if (!scope || typeof sessionStorage === "undefined") return;
  try {
    const key = storageKey(scope);
    const raw = sessionStorage.getItem(key);
    const parsed = raw ? (JSON.parse(raw) as StoredProgress) : null;
    // An old unmounted run must not erase a newer run for this draft.
    if (parsed?.progressId === progressId) sessionStorage.removeItem(key);
  } catch {
    // Ignore storage failures.
  }
}

function newProgressId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `progress-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function responseStatus(error: unknown): number | null {
  const value = error as { status?: unknown; response?: { status?: unknown } };
  const status = value?.status ?? value?.response?.status;
  return typeof status === "number" ? status : null;
}

function structuredRequestError(error: unknown): ImportRoutePlanProgressError {
  const value = error as {
    data?: unknown;
    response?: { data?: unknown };
  };
  const payload = value?.data ?? value?.response?.data;
  const body = payload && typeof payload === "object"
    ? payload as Record<string, unknown>
    : undefined;
  const nestedError = body?.error && typeof body.error === "object"
    ? body.error as Record<string, unknown>
    : undefined;
  return {
    code: typeof body?.code === "string"
      ? body.code
      : typeof nestedError?.code === "string"
        ? nestedError.code
        : "IMPORT_ROUTE_PLAN_FAILED",
    message: typeof body?.message === "string"
      ? body.message
      : typeof body?.error === "string"
        ? body.error
        : typeof body?.detail === "string"
          ? body.detail
          : typeof nestedError?.message === "string"
            ? nestedError.message
            : messageForError(error),
    // Keep the server payload available to the caller. In particular, the
    // vehicle conflict list must not be discarded by the monitor wrapper.
    details: body?.details ?? nestedError?.details ?? payload,
  };
}

function messageForError(error: unknown): string {
  if (error instanceof Error && error.message) return error.message;
  return "The optimization could not be completed.";
}

async function fetchProgress(
  progressId: string,
  signal: AbortSignal,
): Promise<{ response: Response; record?: ImportRoutePlanProgressRecord }> {
  const response = await fetch(
    apiPath(`/import/route-plans/progress/${encodeURIComponent(progressId)}`),
    { credentials: "include", signal, cache: "no-store" },
  );
  if (!response.ok) return { response };
  return { response, record: (await response.json()) as ImportRoutePlanProgressRecord };
}

function updateRecordState(
  record: ImportRoutePlanProgressRecord,
): ImportRoutePlanMonitorState {
  const terminalStatus: ImportRoutePlanProgressStatus =
    record.status === "complete"
      ? "complete"
      : record.status === "error"
        ? "error"
        : isFreshProgressRecord(record)
          ? "running"
          : "reconnecting";
  return {
    progressId: record.progressId,
    status: terminalStatus,
    phase: record.phase,
    startedAt: record.startedAt,
    elapsedMs: getProgressElapsedMs(record),
    progress: record.progress ?? null,
    estimatedRemainingMs: record.estimatedRemainingMs ?? null,
    error: record.error ?? null,
    result: record.result ?? null,
    recordVisible: true,
  };
}

export function useImportRoutePlanMonitor({
  scope,
  onComplete,
  onTerminalError,
}: {
  scope?: ImportRoutePlanMonitorScope;
  onComplete: (result: ImportRoutePlanResult) => Promise<void> | void;
  onTerminalError?: (error: ImportRoutePlanProgressError) => void;
}) {
  const [state, setState] = useState<ImportRoutePlanMonitorState>(emptyState);
  const mountedRef = useRef(true);
  const runRef = useRef(0);
  const activeProgressIdRef = useRef<string | null>(null);
  const pollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pollInFlightRef = useRef(false);
  const postStartedRef = useRef(false);
  const postIssuedRef = useRef(false);
  const submittedAtRef = useRef<number | null>(null);
  const newRunAllowedRef = useRef(false);
  const completionStartedRef = useRef(false);
  const controllersRef = useRef(new Set<AbortController>());
  const serverClockRef = useRef<{ serverMs: number; clientMs: number } | null>(null);
  const onCompleteRef = useRef(onComplete);
  const onTerminalErrorRef = useRef(onTerminalError);
  onCompleteRef.current = onComplete;
  onTerminalErrorRef.current = onTerminalError;

  const clearTimer = useCallback(() => {
    if (pollTimerRef.current !== null) {
      clearTimeout(pollTimerRef.current);
      pollTimerRef.current = null;
    }
  }, []);

  const abortRequests = useCallback(() => {
    for (const controller of controllersRef.current) controller.abort();
    controllersRef.current.clear();
  }, []);

  const finishResult = useCallback(
    async (runId: number, progressId: string, result: ImportRoutePlanResult) => {
      if (
        !mountedRef.current ||
        runId !== runRef.current ||
        completionStartedRef.current
      ) return;
      completionStartedRef.current = true;
      clearTimer();
      setState((current) => ({
        ...current,
        progressId,
        status: "complete",
        phase: "complete",
        result,
      }));
      // Draft persistence belongs to the caller. The recovery record is only
      // consumed after that write and navigation handoff have both succeeded.
      try {
        await onCompleteRef.current(result);
        clearStoredProgress(scope, progressId);
      } catch (error) {
        completionStartedRef.current = false;
        if (mountedRef.current && runId === runRef.current) {
          setState((current) => ({
            ...current,
            status: "error",
            error: {
              code: "RESULT_PERSISTENCE_FAILED",
              message: messageForError(error),
            },
          }));
        }
      }
    },
    [clearTimer, scope],
  );

  const poll = useCallback(
    async (runId: number, progressId: string) => {
      if (
        !mountedRef.current ||
        runId !== runRef.current ||
        activeProgressIdRef.current !== progressId ||
        pollInFlightRef.current
      ) return;
      pollInFlightRef.current = true;
      const controller = new AbortController();
      controllersRef.current.add(controller);
      let timedOut = false;
      const timeout = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, REQUEST_TIMEOUT_MS);
      try {
        const { response, record } = await fetchProgress(progressId, controller.signal);
        if (!mountedRef.current || runId !== runRef.current || completionStartedRef.current) return;
        if (response.status === 401 || response.status === 403) {
          clearTimer();
          const error = {
            code: "AUTH_EXPIRED",
            message: "Your session has expired. Sign in again, then retry checking this optimization.",
          };
          setState((current) => ({ ...current, status: "error", error }));
          onTerminalErrorRef.current?.(error);
          return;
        }
        if (response.status === 404 || !response.ok || !record) {
          setState((current) => ({
            ...current,
            status: response.status === 404
              ? missingProgressStatus(current.recordVisible, submittedAtRef.current, Date.now())
              : "reconnecting",
          }));
        } else {
          if (!isProgressRecordForRun(record.progressId, progressId)) {
            // A successful response for another identity is not authoritative
            // for this run and must never complete or replace its state.
            setState((current) => ({ ...current, status: "reconnecting" }));
          } else {
            serverClockRef.current = {
              serverMs: Date.parse(record.serverNow),
              clientMs: Date.now(),
            };
            if (record.status === "running") {
              newRunAllowedRef.current = false;
            }
            const next = updateRecordState(record);
              if (record.status === "complete" && !isCompleteProgressPayload(record.status, record.result)) {
                // A durable record can briefly be observed before its result
                // envelope is materialized. Keep checking instead of
                // unblocking.
                setState({ ...next, status: "reconnecting" });
              } else {
                setState(next);
                if (record.status === "complete" && record.result) {
                  await finishResult(runId, progressId, record.result);
                  return;
                }
                if (record.status === "error") {
                  clearTimer();
                  newRunAllowedRef.current = true;
                  const terminalError = record.error ?? {
                    code: "IMPORT_ROUTE_PLAN_FAILED",
                    message: "The optimization failed without an error description.",
                  };
                  setState((current) => ({ ...current, error: terminalError }));
                  onTerminalErrorRef.current?.(terminalError);
                  return;
                }
              }
          }
        }
      } catch (error) {
        if (
          mountedRef.current &&
          runId === runRef.current &&
          !completionStartedRef.current &&
          shouldSurfacePollAbort(
            (error as { name?: string }).name,
            timedOut,
          )
        ) {
          setState((current) => ({ ...current, status: "reconnecting" }));
        }
      } finally {
        clearTimeout(timeout);
        controllersRef.current.delete(controller);
        pollInFlightRef.current = false;
      }
      if (
        mountedRef.current &&
        runId === runRef.current &&
        activeProgressIdRef.current === progressId &&
        !completionStartedRef.current
      ) {
        pollTimerRef.current = setTimeout(
          () => void poll(runId, progressId),
          POLL_INTERVAL_MS,
        );
      }
    },
    [clearTimer, finishResult],
  );

  const beginPolling = useCallback(
    (runId: number, progressId: string) => {
      activeProgressIdRef.current = progressId;
      void poll(runId, progressId);
    },
    [poll],
  );

  const start = useCallback(
    async (
      request: ImportRoutePlanInput,
      beforePost?: () => Promise<void>,
    ) => {
      if (activeProgressIdRef.current && newRunAllowedRef.current) {
        clearTimer();
        abortRequests();
        clearStoredProgress(scope, activeProgressIdRef.current);
        activeProgressIdRef.current = null;
        postStartedRef.current = false;
        newRunAllowedRef.current = false;
      }
      if (postStartedRef.current || activeProgressIdRef.current) return;
      postStartedRef.current = true;
      postIssuedRef.current = false;
      submittedAtRef.current = null;
      newRunAllowedRef.current = false;
      completionStartedRef.current = false;
      const runId = ++runRef.current;
      const progressId = newProgressId();
      activeProgressIdRef.current = progressId;
      writeStoredProgress(scope, progressId);
      setState({
        ...emptyState,
        progressId,
        // The server's startedAt is authoritative; this is only the honest
        // pre-response state and is never shown as a ticking elapsed value.
        status: "starting",
      });
      try {
        // Start the visible run before the draft flush barrier. If the
        // barrier fails, cancel this prepared run without ever issuing POST.
        await beforePost?.();
        if (!mountedRef.current || runId !== runRef.current) {
          if (!postIssuedRef.current) clearStoredProgress(scope, progressId);
          return;
        }
        postIssuedRef.current = true;
        submittedAtRef.current = Date.now();
        const requestPromise = createImportRoutePlan(
          { ...request, progressId } as ImportRoutePlanInput & { progressId: string },
        );
        // Do not poll before the draft flush: no server run exists yet.
        beginPolling(runId, progressId);
        const result = await requestPromise;
        if (!mountedRef.current || runId !== runRef.current) return;
        // Some deployments finish the POST synchronously. Treat that result
        // exactly like a durable GET completion and still consume once.
        await finishResult(runId, progressId, result);
      } catch (error) {
        if (completionStartedRef.current) return;
        if (!mountedRef.current || runId !== runRef.current) {
          // A draft barrier that failed before POST was issued cannot be
          // resumed after reload. A POST that was issued must remain
          // recoverable through the durable GET, even after unmount.
          if (!postIssuedRef.current) {
            clearStoredProgress(scope, progressId);
          }
          return;
        }
        if (!postIssuedRef.current) {
          clearTimer();
          abortRequests();
          clearStoredProgress(scope, progressId);
          activeProgressIdRef.current = null;
          postStartedRef.current = false;
          setState(emptyState);
          onTerminalErrorRef.current?.({
            code: "DRAFT_SAVE_FAILED",
            message: messageForError(error),
          });
          return;
        }
        const status = responseStatus(error);
        const requestError = structuredRequestError(error);
        if (status === 401 || status === 403) {
          clearTimer();
          const authError = {
            code: "AUTH_EXPIRED",
            message: "Your session has expired. Sign in again, then retry this optimization.",
          };
          setState((current) => ({ ...current, status: "error", error: authError }));
          onTerminalErrorRef.current?.(authError);
        } else if (isDefinitivePlanRejection(status, requestError.code)) {
          clearTimer();
          // Invalidate an already in-flight poll before it can overwrite the
          // terminal POST response with "reconnecting".
          ++runRef.current;
          abortRequests();
          clearStoredProgress(scope, progressId);
          newRunAllowedRef.current = true;
          setState((current) => ({ ...current, status: "error", error: requestError }));
          onTerminalErrorRef.current?.(requestError);
        } else {
          // A timeout/gateway failure says nothing about whether the POST
          // committed. Never replay it; the authoritative GET remains active.
          setState((current) => ({ ...current, status: "reconnecting" }));
        }
      }
    },
    [abortRequests, beginPolling, clearTimer, finishResult, scope, state.status],
  );

  const retryChecking = useCallback(() => {
    const progressId = activeProgressIdRef.current;
    if (!progressId || completionStartedRef.current) return;
    const runId = runRef.current;
    clearTimer();
    setState((current) => ({ ...current, status: "reconnecting" }));
    void poll(runId, progressId);
  }, [clearTimer, poll]);

  useEffect(() => {
    mountedRef.current = true;
    const storedProgressId = readStoredProgress(scope);
    if (storedProgressId && !activeProgressIdRef.current) {
      const runId = ++runRef.current;
      activeProgressIdRef.current = storedProgressId;
      postStartedRef.current = true;
      setState((current) => ({ ...current, progressId: storedProgressId, status: "reconnecting" }));
      beginPolling(runId, storedProgressId);
    }
    return () => {
      mountedRef.current = false;
      runRef.current += 1;
      clearTimer();
      abortRequests();
    };
  }, [abortRequests, beginPolling, clearTimer, scope]);

  // Keep elapsed time anchored to server startedAt/serverNow. ETA is never
  // decremented locally: null remains unknown until the backend provides it.
  useEffect(() => {
    if (state.status !== "running" || !state.startedAt || !serverClockRef.current) return;
    const timer = setInterval(() => {
      if (!mountedRef.current || !serverClockRef.current) return;
      const startedMs = Date.parse(state.startedAt!);
      const serverNowMs =
        Date.now() +
        (serverClockRef.current.serverMs - serverClockRef.current.clientMs);
      if (Number.isFinite(startedMs)) {
        setState((current) => ({
          ...current,
          elapsedMs: Math.max(0, serverNowMs - startedMs),
        }));
      }
    }, 1_000);
    return () => clearInterval(timer);
  }, [state.startedAt, state.status]);

  return {
    state,
    // Auth failures and persistence failures are still attached to an
    // unknown original run: keep controls blocked so the user cannot submit
    // a second POST. Only a server-confirmed terminal error or a definitive
    // pre-worker request rejection permits a new run.
    isBusy: Boolean(state.progressId) &&
      state.status !== "complete" &&
      (state.status !== "error" || !newRunAllowedRef.current),
    start,
    retryChecking,
  };
}
