export const IMPORT_INFO_CATEGORIES = ["overview", "stats", "limits", "help"] as const;
export type ImportInfoCategory = (typeof IMPORT_INFO_CATEGORIES)[number];
export type ImportInfoVisibility = Record<ImportInfoCategory, boolean>;

export const IMPORT_INFO_LABELS: Record<ImportInfoCategory, string> = {
  overview: "Planöversikt",
  stats: "Importstatistik",
  limits: "Planeringsgränser",
  help: "Hjälptexter",
};

export function defaultImportInfoVisibility(): ImportInfoVisibility {
  return { overview: false, stats: false, limits: false, help: false };
}

export function toggleImportInfo(state: ImportInfoVisibility, category: ImportInfoCategory, open?: boolean): ImportInfoVisibility {
  return { ...state, [category]: open ?? !state[category] };
}

/** Import counts that require planner action are never collapsed. */
const ACTION_COUNT_KEYS = new Set(["action", "rejected"]);
export function isAlwaysVisibleCount(key: string, count: number): boolean {
  return ACTION_COUNT_KEYS.has(key) && count > 0;
}

/** Status chain parts: status, next action, blockers and errors always visible; the rest is supplementary. */
export type StatusChainPart = "status" | "nextAction" | "blockers" | "error" | "loading" | "context" | "lifecycle" | "steps" | "revision";
export function isStatusChainPartVisible(part: StatusChainPart, detailsOpen: boolean): boolean {
  if (part === "status" || part === "nextAction" || part === "blockers" || part === "error" || part === "loading") return true;
  return detailsOpen;
}
