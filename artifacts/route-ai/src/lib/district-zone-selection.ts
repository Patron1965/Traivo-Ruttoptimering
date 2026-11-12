import type { DistrictEndpoint, DistrictJob } from "./district-api";

export interface OptimizeState {
  zoneId: string | null;
  mode: "loop" | "open";
  start: DistrictEndpoint | null;
  end: DistrictEndpoint | null;
  useEnd: boolean;
  serviceMinutes: number;
  pick: "start" | "end" | null;
  jobId: string | null;
  from: number;
  to: number;
}

export const initialOptimizeState: OptimizeState = {
  zoneId: null, mode: "loop", start: null, end: null, useEnd: false,
  serviceMinutes: 6, pick: null, jobId: null, from: 1, to: 1,
};

export function selectOptimizationZone(
  state: OptimizeState,
  zoneId: string,
  jobs: readonly DistrictJob[],
): OptimizeState {
  if (state.zoneId === zoneId) return state;
  const latest = jobs.filter((job) => job.zoneId === zoneId)
    .sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""))[0];
  return {
    ...initialOptimizeState, zoneId,
    serviceMinutes: latest?.serviceMinutes ?? state.serviceMinutes,
    jobId: latest?.id ?? null,
    mode: latest?.mode ?? "loop",
    start: latest?.start ?? null,
    end: latest?.end ?? null,
    useEnd: !!latest?.end,
  };
}