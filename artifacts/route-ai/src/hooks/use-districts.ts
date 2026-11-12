import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { districtApi, type DistrictPoint, type ImportPayload, type JobInput, type ZoneInput } from "@/lib/district-api";

export const districtKeys = {
  plans: ["district", "plans"] as const,
  plan: (planId: string) => ["district", "plan", planId] as const,
  points: (planId: string) => ["district", "points", planId] as const,
  job: (planId: string, jobId: string) => ["district", "job", planId, jobId] as const,
  exports: (planId: string) => ["district", "exports", planId] as const,
};

const PAGE = 1000;

export function useDistrictPlans() {
  return useQuery({ queryKey: districtKeys.plans, queryFn: districtApi.listPlans, staleTime: 15_000, refetchOnWindowFocus: true });
}

export function useCreateDistrictPlan() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (name: string) => districtApi.createPlan(name),
    onSuccess: () => qc.invalidateQueries({ queryKey: districtKeys.plans }),
  });
}

export function useDistrictPlan(planId: string) {
  return useQuery({
    queryKey: districtKeys.plan(planId),
    queryFn: () => districtApi.getPlan(planId),
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    // Freshness: pick up colleagues' zone revisions. Drafts live in local
    // component state and are never overwritten by this refetch.
    refetchInterval: 30_000,
  });
}

/** Loads every point in 1000-row pages; the dataset is immutable after import. */
export function useDistrictPoints(planId: string) {
  return useQuery({
    queryKey: districtKeys.points(planId),
    queryFn: async () => {
      const all: DistrictPoint[] = [];
      let total = Infinity;
      while (all.length < total) {
        const page = await districtApi.listPoints(planId, PAGE, all.length);
        total = page.total;
        all.push(...page.points);
        if (page.points.length === 0) break;
      }
      return { points: all, total: total === Infinity ? 0 : total };
    },
    staleTime: 20_000,
    refetchOnWindowFocus: true,
  });
}

export function usePreviewDistrictImport(planId: string) {
  return useMutation({ mutationFn: (payload: ImportPayload) => districtApi.previewImport(planId, payload) });
}

export function useCommitDistrictImport(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (payload: ImportPayload & { confirmValidOnly: boolean }) => districtApi.commitImport(planId, payload),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: districtKeys.plan(planId) });
      void qc.invalidateQueries({ queryKey: districtKeys.points(planId) });
      void qc.invalidateQueries({ queryKey: districtKeys.plans });
    },
  });
}

function useRefreshPlan(planId: string) {
  const qc = useQueryClient();
  return () => {
    void qc.invalidateQueries({ queryKey: districtKeys.plan(planId) });
    void qc.invalidateQueries({ queryKey: districtKeys.points(planId) });
  };
}

export function useSaveDistrictZone(planId: string) {
  const refresh = useRefreshPlan(planId);
  return useMutation({
    mutationFn: (args: { zoneId: string | null; expectedRevision?: number; input: ZoneInput }) =>
      args.zoneId
        ? districtApi.updateZone(planId, args.zoneId, { ...args.input, expectedRevision: args.expectedRevision ?? 0 })
        : districtApi.createZone(planId, args.input),
    onSuccess: refresh,
  });
}

export function useDeleteDistrictZone(planId: string) {
  const refresh = useRefreshPlan(planId);
  return useMutation({
    mutationFn: (args: { zoneId: string; expectedRevision: number }) => districtApi.deleteZone(planId, args.zoneId, args.expectedRevision),
    onSuccess: refresh,
  });
}

export function useStartDistrictJob(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { zoneId: string; input: JobInput }) => districtApi.startJob(planId, args.zoneId, args.input),
    onSuccess: () => qc.invalidateQueries({ queryKey: districtKeys.plan(planId) }),
  });
}

const ACTIVE = new Set(["queued", "running"]);

export function useDistrictJob(planId: string, jobId: string | null) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: districtKeys.job(planId, jobId ?? "none"),
    queryFn: async () => {
      const data = await districtApi.getJob(planId, jobId!);
      if (!ACTIVE.has(data.job.status)) void qc.invalidateQueries({ queryKey: districtKeys.plan(planId) });
      return data;
    },
    enabled: !!jobId,
    staleTime: 0,
    refetchInterval: (query) => (query.state.data && !ACTIVE.has(query.state.data.job.status) ? false : 1500),
  });
}

export function useCancelDistrictJob(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (jobId: string) => districtApi.cancelJob(planId, jobId),
    onSuccess: (_data, jobId) => {
      void qc.invalidateQueries({ queryKey: districtKeys.job(planId, jobId) });
      void qc.invalidateQueries({ queryKey: districtKeys.plan(planId) });
    },
  });
}

export function useDistrictExports(planId: string) {
  return useQuery({ queryKey: districtKeys.exports(planId), queryFn: () => districtApi.listExports(planId), refetchOnWindowFocus: true });
}

export function useCreateDistrictExport(planId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (args: { jobId: string; pointIds: string[]; columns: string[]; confirmReexport: boolean }) =>
      districtApi.createExport(planId, args.jobId, { pointIds: args.pointIds, columns: args.columns, confirmReexport: args.confirmReexport }),
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: districtKeys.exports(planId) });
      void qc.invalidateQueries({ queryKey: districtKeys.plan(planId) });
      void qc.invalidateQueries({ queryKey: districtKeys.points(planId) });
    },
  });
}
