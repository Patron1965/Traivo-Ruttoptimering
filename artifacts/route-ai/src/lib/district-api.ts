// Thin client for the isolated district-planning API described in
// .local/district-api-contract.md. The global fetch wrapper in
// workspace-context.ts adds the Superuser workspace header; the server
// derives organization scope, so organizationId is never sent.
// TODO: swap internals for generated @workspace/api-client-react hooks once
// codegen for /district-plans lands. Signatures mirror the contract.

export interface DistrictPlan {
  id: string;
  name: string;
  createdAt?: string;
  updatedAt?: string;
  pointCount?: number;
  zoneCount?: number;
  revision?: number;
}

export interface LatLng { lat: number; lng: number }

export interface DistrictZone {
  id: string;
  name: string;
  color: string;
  revision: number;
  polygon?: LatLng[] | null;
  pointCount?: number;
  pointIds?: string[];
  deletedAt?: string | null;
  updatedAt?: string;
}

export interface DistrictImport {
  id: string;
  total: number;
  valid: number;
  rejected: number;
  revision?: number;
  createdAt?: string;
  sourceKey?: string;
}

export type DistrictJobStatus = "queued" | "running" | "completed" | "failed" | "cancelled" | "stale";

export interface DistrictEndpoint { pointId?: string; latitude?: number; longitude?: number }

export interface DistrictJob {
  id: string;
  zoneId: string;
  status: DistrictJobStatus;
  progress: number;
  mode?: "loop" | "open";
  /** Zone revision the job was computed against. */
  revision: number;
  result?: DistrictResult;
  error?: string | null;
  createdAt?: string;
  updatedAt?: string;
  start?: DistrictEndpoint;
  end?: DistrictEndpoint | null;
  serviceMinutes?: number;
  bulkScope?: "zone"|"plan";
  datasetIdentity?: string;
}

export interface DistrictResult {
  orderedPointIds: string[];
  distanceMeters: number;
  driveSeconds: number;
  serviceSeconds?: number;
  geometry: { latitude: number; longitude: number }[];
  warnings: string[];
}

export interface DistrictExport {
  id: string;
  jobId: string;
  zoneId?: string;
  createdAt: string;
  actorName?: string;
  actorId?: string;
  createdBy?: string;
  pointIds?: string[];
  pointCount?: number;
  columns?: string[];
  fromSequence?: number;
  toSequence?: number;
}

export interface DistrictPoint {
  id: string;
  sourceRowNumber: number;
  objectNumber: string;
  address: string;
  latitude: number;
  longitude: number;
  original: Record<string, string>;
  zoneId: string | null;
  exported: boolean;
}

export interface DistrictPlanDetail {
  plan: DistrictPlan;
  zones: DistrictZone[];
  imports: DistrictImport[];
  jobs: DistrictJob[];
  exports: DistrictExport[];
}

export interface ImportMapping { objectNumber: string; address: string; latitude: string; longitude: string }

/** Explicit physical 1-based source line; malformed parser rows keep raw cells and parseError so the server rejects them. */
export interface DistrictSourceRow {
  sourceRowNumber: number;
  original: Record<string, string>;
  parseError?: string;
}

export interface ImportPayload {
  rows: DistrictSourceRow[];
  mapping: ImportMapping;
  sourceKey: string;
}

export interface ImportPreview {
  total: number;
  valid: number;
  rejected: number;
  issues: { rowNumber: number; reason: string }[];
  duplicateCandidates: { rowNumber: number; otherRowNumber: number }[];
}

export interface ZoneInput {
  name: string;
  color: string;
  pointIds: string[];
  transfers?: string[];
  polygon?: LatLng[];
}

export interface JobInput {
  expectedRevision: number;
  mode: "loop" | "open";
  start: DistrictEndpoint;
  end?: DistrictEndpoint;
  serviceMinutes?: number;
  bulkScope?: "zone"|"plan";
  bulkPreviewHash?: string;
  distanceExceptions?: {pointId:string;maxSnapMeters:number;reason:string}[];
}

export class DistrictApiError extends Error {
  constructor(message: string, readonly status: number, readonly code?: string) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(`/api${path}`, {
    credentials: "include",
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (response.status === 204) return undefined as T;
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    const fallback = response.status === 403
      ? "Du saknar behörighet för distriktsplanering."
      : response.status === 409
        ? "Underlaget har ändrats sedan det lästes in. Läs in igen och försök på nytt."
        : `Begäran misslyckades (${response.status}).`;
    throw new DistrictApiError(body?.error ?? fallback, response.status, body?.code);
  }
  return body as T;
}

const json = (method: string, body?: unknown): RequestInit => ({ method, body: body === undefined ? undefined : JSON.stringify(body) });
const base = (planId: string) => `/district-plans/${encodeURIComponent(planId)}`;

export const districtApi = {
  previewBulk: (planId:string,zoneId:string,input:JobInput) =>
    request<import("@workspace/api-client-react").DistrictBulkPreview>(`${base(planId)}/zones/${encodeURIComponent(zoneId)}/bulk-preview`,json("POST",input)),
  listPlans: () => request<{ plans: DistrictPlan[] }>("/district-plans"),
  createPlan: (name: string) => request<DistrictPlan>("/district-plans", json("POST", { name })),
  getPlan: (planId: string) => request<DistrictPlanDetail>(base(planId)),
  previewImport: (planId: string, payload: ImportPayload) =>
    request<ImportPreview>(`${base(planId)}/imports/preview`, json("POST", payload)),
  commitImport: (planId: string, payload: ImportPayload & { confirmValidOnly: boolean }) =>
    request<DistrictImport>(`${base(planId)}/imports`, json("POST", payload)),
  listPoints: (planId: string, limit: number, offset: number) =>
    request<{ points: DistrictPoint[]; total: number }>(`${base(planId)}/points?limit=${limit}&offset=${offset}`),
  createZone: (planId: string, input: ZoneInput) => request<DistrictZone>(`${base(planId)}/zones`, json("POST", input)),
  updateZone: (planId: string, zoneId: string, input: ZoneInput & { expectedRevision: number }) =>
    request<DistrictZone>(`${base(planId)}/zones/${encodeURIComponent(zoneId)}`, json("PUT", input)),
  deleteZone: (planId: string, zoneId: string, expectedRevision: number) =>
    request<void>(`${base(planId)}/zones/${encodeURIComponent(zoneId)}`, json("DELETE", { expectedRevision, confirm: true })),
  startJob: (planId: string, zoneId: string, input: JobInput) =>
    request<{ id: string; status: DistrictJobStatus; progress: number }>(`${base(planId)}/zones/${encodeURIComponent(zoneId)}/jobs`, json("POST", input)),
  // Generated DistrictJobEnvelope: {job}; result is job.result and
  // job.revision is the zone revision the job was computed against.
  getJob: (planId: string, jobId: string) => request<{ job: DistrictJob }>(`${base(planId)}/jobs/${encodeURIComponent(jobId)}`),
  cancelJob: (planId: string, jobId: string) =>
    request<{ job: DistrictJob }>(`${base(planId)}/jobs/${encodeURIComponent(jobId)}/cancel`, json("POST")),
  createExport: (planId: string, jobId: string, input: { pointIds: string[]; columns: string[]; confirmReexport: boolean }) =>
    request<{ export: DistrictExport; overlapPointIds: string[] }>(`${base(planId)}/jobs/${encodeURIComponent(jobId)}/exports`, json("POST", input)),
  listExports: (planId: string) => request<{ exports: DistrictExport[] }>(`${base(planId)}/exports`),
  exportFileUrl: (planId: string, exportId: string, format: "csv" | "xlsx") =>
    `/api${base(planId)}/exports/${encodeURIComponent(exportId)}/file?format=${format}`,
};

export async function downloadDistrictExport(planId: string, exportId: string, format: "csv" | "xlsx") {
  const response = await fetch(districtApi.exportFileUrl(planId, exportId, format), { credentials: "include" });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    throw new DistrictApiError(body?.error ?? "Filen kunde inte hämtas.", response.status, body?.code);
  }
  const blob = await response.blob();
  const disposition = response.headers.get("Content-Disposition") ?? "";
  const match = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition);
  const name = match ? decodeURIComponent(match[1]) : `distriktsuttag-${exportId.slice(0, 8)}.${format}`;
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = name;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
