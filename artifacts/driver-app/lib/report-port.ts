import { api, ensureRouteExecutionForWork } from "./api";
import type { StopReportPort } from "./stop-report";

export const stopReportPort: StopReportPort = {
  getStop: api.getStop,
  proof: api.submitProof,
  event: api.createStopExecutionEvent,
  pickup: async (routeId, stopId, version, occurredAt) => {
    await ensureRouteExecutionForWork(routeId, version, occurredAt);
    return api.updateStop(stopId, { status: "in_progress" });
  },
};
