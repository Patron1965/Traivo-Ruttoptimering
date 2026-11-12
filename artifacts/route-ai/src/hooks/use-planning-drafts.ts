import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { useAuth } from "@/lib/auth-context";
import { updatePlanningDraftRequest } from "@/lib/planning-draft-request";
import { useCallback, useEffect, useRef } from "react";

export interface PlanningDraft {
  id: string;
  organizationId: string;
  name: string;
  startAt: string;
  state: any;
  revision: number;
  importedResult: any | null;
  planId: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanningDraftUpdateData {
  revision: number;
  name?: string;
  startAt?: string;
  state?: any;
}

export type PlanningDraftSavePayload = Omit<PlanningDraftUpdateData, "revision"> & {
  /**
   * The revision is retained for callers that already have one, but the
   * serialized saver always replaces it with the latest server revision.
   */
  revision?: number;
};

type DraftSaveWaiter = {
  payload: PlanningDraftSavePayload;
  resolve: (draft: PlanningDraft) => void;
  reject: (error: unknown) => void;
};

async function fetchDraftRead(path: string): Promise<Response> {
  let response: Response | undefined;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    response = await fetch(path, { cache: "no-store", credentials: "include" });
    if (![502, 503, 504].includes(response.status)) return response;
    await new Promise((resolve) => window.setTimeout(resolve, 250 * (attempt + 1)));
  }
  return response!;
}

export function usePlanningDrafts() {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["planning-drafts", user?.organizationId],
    queryFn: async () => {
      if (!user?.organizationId) return [];
      const res = await fetch("/api/planning-drafts", { credentials: "include" });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load drafts (${res.status})`);
      }
      const data = await res.json();
      return data.drafts as PlanningDraft[];
    },
    enabled: !!user?.organizationId,
  });
}

export function usePlanningDraft(id: string | null) {
  const { user } = useAuth();
  return useQuery({
    queryKey: ["planning-drafts", user?.organizationId, id],
    queryFn: async () => {
      if (!id) return null;
      const res = await fetchDraftRead(`/api/planning-drafts/${id}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to load draft (${res.status})`);
      }
      return (await res.json()) as PlanningDraft;
    },
    enabled: !!id && !!user?.organizationId,
  });
}

export function useCreatePlanningDraft() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async (data: { name: string; startAt: string; state: any }) => {
      const res = await fetch("/api/planning-drafts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(data),
        credentials: "include",
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        throw new Error(payload.error || `Failed to create draft (${res.status})`);
      }
      return (await res.json()) as PlanningDraft;
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["planning-drafts", user?.organizationId] });
    },
  });
}

export function useUpdatePlanningDraft() {
  const queryClient = useQueryClient();
  const { user } = useAuth();
  return useMutation({
    mutationFn: async ({ id, data }: { id: string; data: PlanningDraftUpdateData }) => {
      return updatePlanningDraftRequest<PlanningDraft>(id, data);
    },
    onSuccess: (updated) => {
      queryClient.invalidateQueries({ queryKey: ["planning-drafts", user?.organizationId] });
      // The detail query is organization scoped. Updating the unscoped key
      // here left autosaves reading an old revision and caused avoidable 409s.
      queryClient.setQueryData(
        ["planning-drafts", user?.organizationId, updated.id],
        updated,
      );
    },
  });
}

/**
 * Debounced, serialized draft writes.
 *
 * A wizard can emit several updates while a user edits an address. React
 * Query mutations do not serialize those requests, so two PUTs could carry
 * the same revision and one would lose the user's latest state. This helper
 * keeps only the newest pending snapshot, writes it after a short debounce,
 * then uses the revision returned by the server for the next write.
 */
export function usePlanningDraftAutosave(
  draftId: string | null,
  initialRevision?: number,
  debounceMs = 250,
) {
  const updateDraft = useUpdatePlanningDraft();
  const revisionRef = useRef(initialRevision ?? 0);
  const draftIdRef = useRef(draftId);
  const pendingRef = useRef<DraftSaveWaiter | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const chainRef = useRef<Promise<PlanningDraft | undefined>>(Promise.resolve(undefined));

  useEffect(() => {
    if (draftIdRef.current !== draftId) {
      draftIdRef.current = draftId;
      revisionRef.current = initialRevision ?? 0;
      pendingRef.current?.reject(new Error("DRAFT_SWITCHED"));
      pendingRef.current = null;
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = null;
    } else if (initialRevision != null && !pendingRef.current) {
      revisionRef.current = initialRevision;
    }
  }, [draftId, initialRevision]);

  const executePending = useCallback(() => {
    const pending = pendingRef.current;
    pendingRef.current = null;
    if (!pending || !draftIdRef.current) {
      return chainRef.current;
    }

    const id = draftIdRef.current;
    const write = chainRef.current.then(async () => {
      if (draftIdRef.current !== id) {
        const switched = new Error("DRAFT_SWITCHED");
        pending.reject(switched);
        throw switched;
      }
      const updated = await updateDraft.mutateAsync({
        id,
        data: {
          ...pending.payload,
          revision: revisionRef.current,
        },
      });
      if (draftIdRef.current === id) revisionRef.current = updated.revision;
      pending.resolve(updated);
      return updated;
    }).catch((error) => {
      pending.reject(error);
      throw error;
    });

    // Keep the chain alive after an error. A later explicit retry must not be
    // poisoned by a rejected promise from an earlier network failure.
    chainRef.current = write.catch(() => undefined);
    return write;
  }, [updateDraft]);

  const flush = useCallback(async () => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    const execution = executePending();
    await execution;
    await chainRef.current;
  }, [executePending]);

  const schedule = useCallback(
    (payload: PlanningDraftSavePayload, options: { immediate?: boolean } = {}) => {
      if (!draftId) return Promise.resolve(undefined as PlanningDraft | undefined);
      const previous = pendingRef.current;
      if (previous) {
        // Every waiter observes the server response for the newest snapshot.
        // This also makes awaiting a superseded navigation save deterministic.
        pendingRef.current = {
          payload,
          resolve: (value) => {
            previous.resolve(value);
          },
          reject: (error) => {
            previous.reject(error);
          },
        };
      } else {
        let resolve!: (value: PlanningDraft) => void;
        let reject!: (error: unknown) => void;
        const promise = new Promise<PlanningDraft>((res, rej) => {
          resolve = res;
          reject = rej;
        });
        pendingRef.current = { payload, resolve, reject };

        if (options.immediate) {
          void flush().catch(() => undefined);
        } else {
          timerRef.current = setTimeout(() => {
            timerRef.current = null;
            void executePending().catch(() => undefined);
          }, debounceMs);
        }
        return promise;
      }

      if (options.immediate) {
        void flush().catch(() => undefined);
      } else {
        if (timerRef.current) clearTimeout(timerRef.current);
        timerRef.current = setTimeout(() => {
          timerRef.current = null;
          void executePending().catch(() => undefined);
        }, debounceMs);
      }
      return new Promise<PlanningDraft>((resolve, reject) => {
        const current = pendingRef.current;
        if (current) {
          const oldResolve = current.resolve;
          const oldReject = current.reject;
          current.resolve = (value) => {
            oldResolve(value);
            resolve(value);
          };
          current.reject = (error) => {
            oldReject(error);
            reject(error);
          };
        } else {
          resolve(undefined as unknown as PlanningDraft);
        }
      });
    },
    [debounceMs, draftId, executePending, flush],
  );

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  return { schedule, flush, revisionRef };
}
