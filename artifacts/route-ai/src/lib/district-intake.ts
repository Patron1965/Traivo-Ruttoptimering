import { request } from "./district-api";
import type { SourceRowPayload } from "./district-source-rows";

export type IntakeMapping = Record<"objectNumber" | "address" | "latitude" | "longitude" | "postalCode" | "city", string>;
export interface IntakeRow {
  sourceRowNumber: number;
  original: Record<string, string>;
  objectNumber: string;
  address: string;
  status: "ready" | "unresolved" | "rejected";
  reason: string;
  candidates?: { latitude: number; longitude: number; displayName: string }[];
}
export interface Intake {
  revision: number;
  total: number;
  ready: number;
  unresolved: number;
  rejected: number;
  rows: IntakeRow[];
}
export interface DraftSource {
  id: string; name: string; revision: number; headers: string[];
  sourceRowCount: number; mappedRowCount: number;
}
export const intakeKey = (id: string) => ["district", "intake", id] as const;
const base = (id: string) => `/district-plans/${encodeURIComponent(id)}/intake`;
const post = (body: unknown) => ({ method: "POST", body: JSON.stringify(body) });
export const intakeApi = {
  get: (id: string) => request<{ intake: Intake | null }>(base(id)),
  sources: () => request<{ sources: DraftSource[] }>("/district-intake/sources"),
  create: (id: string, body: { sourceKey: string; rows: SourceRowPayload[]; mapping: IntakeMapping }) =>
    request<{ intake: Intake }>(base(id), post(body)),
  copy: (id: string, body: { draftId: string; revision: number; mapping: IntakeMapping }) =>
    request<{ intake: Intake }>(`${base(id)}/from-draft`, post(body)),
  review: (id: string, row: number, action: "search" | "accept", body: { revision: number; address?: string; candidateIndex?: number; objectNumber?: string }) =>
    request<{ intake: Intake }>(`${base(id)}/rows/${row}/${action}`, post(body)),
};
export const intakeMappingValid = (mapping: IntakeMapping) => {
  const selected = Object.values(mapping).filter(Boolean);
  return Boolean(mapping.objectNumber && mapping.address) && new Set(selected).size === selected.length;
};
export const intakeBalanced = (intake: Intake) =>
  intake.total === intake.ready + intake.unresolved + intake.rejected && intake.rows.length === intake.total;