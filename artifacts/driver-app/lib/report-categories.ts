import { api, getAuthenticatedOrganizationId } from "./api";
import { getCachedData, setCachedData } from "./offline-queue";
import type { SkipReason } from "./stop-report";
import { loadScopedCategories, type ReportCategory } from "./report-category-cache";

export type { ReportCategory } from "./report-category-cache";
export interface CustomCategoryChoice { id: string; label: string }

/** Active org categories; network first, falling back to a per-organization cache. */
export async function loadReportCategories(online: boolean): Promise<ReportCategory[]> {
  return loadScopedCategories(online, {
    organizationId: getAuthenticatedOrganizationId,
    fetch: () => api.getReportCategories(),
    read: (key, age) => getCachedData<ReportCategory[]>(key, age),
    write: (key, value) => setCachedData(key, value),
  });
}

export function restoreCustomCategory(value: unknown): CustomCategoryChoice | null {
  if (!value || typeof value !== "object") return null;
  const { id, label } = value as Record<string, unknown>;
  return typeof id === "string" && typeof label === "string" && label.trim() ? { id, label } : null;
}

/** Frozen at creation: label and id are stored as text so renames never rewrite old reports. */
export function customCategoryLine(choice: CustomCategoryChoice): string {
  return `Orsak: ${choice.label} (kategori ${choice.id})`;
}

export function skipReasonLine(reason: SkipReason, label: string): string {
  return `Orsak: ${label} (${reason})`;
}
