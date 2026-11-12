/**
 * Live actual terminal reports for the dispatch timeline.
 *
 * The plan timing is never touched. A terminal report (completed, failed,
 * skipped) is shown as a separate mark at the reported Stockholm wall-clock
 * time. It is not an arrival, and no forecast is ever derived for pending
 * stops. Missing/invalid times and times outside the visible grid are
 * reported explicitly instead of being clamped to a false position.
 */
export const STOCKHOLM_TZ = "Europe/Stockholm";

export type ActualTerminalKind = "completed" | "failed" | "skipped";

export const ACTUAL_KIND_LABEL: Record<ActualTerminalKind, string> = {
  completed: "Genomfört",
  failed: "Misslyckat",
  skipped: "Överhoppat",
};

export function actualTerminalKind(status: string | null | undefined): ActualTerminalKind | null {
  return status === "completed" || status === "failed" || status === "skipped" ? status : null;
}

export interface StockholmParts {
  date: string; // YYYY-MM-DD
  hour: number; // fractional hour of day
  time: string; // HH:MM
}

let stockholmFormatter: Intl.DateTimeFormat | null = null;

export function stockholmParts(date: Date): StockholmParts | null {
  if (!Number.isFinite(date.getTime())) return null;
  stockholmFormatter ??= new Intl.DateTimeFormat("sv-SE", {
    timeZone: STOCKHOLM_TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  });
  const parts = stockholmFormatter.formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const h = Number(get("hour")), m = Number(get("minute")), s = Number(get("second"));
  if (![h, m, s].every(Number.isFinite)) return null;
  return {
    date: `${get("year")}-${get("month")}-${get("day")}`,
    hour: h + m / 60 + s / 3600,
    time: `${get("hour")}:${get("minute")}`,
  };
}

/** Display-only Stockholm hour of day; NaN for invalid dates. Never persisted. */
export function stockholmHour(date: Date): number {
  return stockholmParts(date)?.hour ?? Number.NaN;
}

/** "2026-11-09" -> "9 nov" */
export function shortSwedishDate(isoDay: string): string {
  const [y, mo, d] = isoDay.split("-").map(Number);
  if (!y || !mo || !d) return isoDay;
  const months = ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "aug", "sep", "okt", "nov", "dec"];
  return `${d} ${months[mo - 1] ?? ""}`.trim();
}

export type ActualMarkPlacement = "in_grid" | "before_grid" | "after_grid" | "invalid_time";

export interface ActualMark {
  stopId: string;
  sequenceOrder: number;
  kind: ActualTerminalKind;
  placement: ActualMarkPlacement;
  /** Pixel x inside the grid; only for in_grid. */
  x: number | null;
  time: string | null;
  /** Stockholm calendar day of the report. */
  day: string | null;
  /** True when the report day differs from the route's planning date. */
  otherDay: boolean;
  /** Compact visible label, e.g. "#1 Fakt. 10:21" or "#1 Fakt. 9 nov 10:21". */
  label: string;
  /** Full accessible description. */
  description: string;
}

export interface ActualMarkInput {
  stopId: string;
  sequenceOrder: number;
  status: string;
  terminalAt?: string | null;
}

export function buildActualMarks(
  stops: ActualMarkInput[],
  routeDate: string | null | undefined,
  grid: { startHour: number; endHour: number; width: number },
): ActualMark[] {
  const planDay = routeDate ? routeDate.slice(0, 10) : null;
  const span = Math.max(1, grid.endHour - grid.startHour);
  const marks: ActualMark[] = [];
  for (const stop of stops) {
    const kind = actualTerminalKind(stop.status);
    if (!kind) continue; // pending stops: no forecast, no mark
    const kindLabel = ACTUAL_KIND_LABEL[kind];
    const parsed = stop.terminalAt ? stockholmParts(new Date(stop.terminalAt)) : null;
    if (!parsed) {
      marks.push({
        stopId: stop.stopId, sequenceOrder: stop.sequenceOrder, kind,
        placement: "invalid_time", x: null, time: null, day: null, otherDay: false,
        label: `#${stop.sequenceOrder} Fakt. tid saknas`,
        description: `#${stop.sequenceOrder} ${kindLabel} · faktisk tid saknas`,
      });
      continue;
    }
    const otherDay = Boolean(planDay && parsed.date !== planDay);
    const label = `#${stop.sequenceOrder} Fakt. ${otherDay ? `${shortSwedishDate(parsed.date)} ` : ""}${parsed.time}`;
    // A report on another day can never be placed on this day's hour grid.
    let placement: ActualMarkPlacement = "in_grid";
    if (otherDay) placement = parsed.date < (planDay ?? "") ? "before_grid" : "after_grid";
    else if (parsed.hour < grid.startHour) placement = "before_grid";
    else if (parsed.hour > grid.endHour) placement = "after_grid";
    const x = placement === "in_grid" ? ((parsed.hour - grid.startHour) / span) * grid.width : null;
    marks.push({
      stopId: stop.stopId, sequenceOrder: stop.sequenceOrder, kind, placement, x,
      time: parsed.time, day: parsed.date, otherDay, label,
      description: `#${stop.sequenceOrder} ${kindLabel} ${otherDay ? `${parsed.date} ` : ""}${parsed.time} · faktisk rapporterad tid (Stockholm)${otherDay && planDay ? `, plandatum ${planDay}` : ""}`,
    });
  }
  return marks.sort((a, b) => (a.x ?? -1) - (b.x ?? -1) || a.sequenceOrder - b.sequenceOrder);
}

/** Conservative rendered width of a compact label (10px mono). */
export function actualLabelWidth(label: string): number {
  return label.length * 6.2 + 6;
}

/**
 * Hide labels that would overlap a previously shown label; the tick stays,
 * and full details remain in the title and stop selection.
 */
export function compactActualLabels(marks: ActualMark[], gap = 3): Set<string> {
  const shown = new Set<string>();
  let lastEnd = -Infinity;
  for (const mark of marks) {
    if (mark.placement !== "in_grid" || mark.x === null) continue;
    const width = actualLabelWidth(mark.label);
    const start = mark.x - width / 2;
    if (start >= lastEnd + gap) {
      shown.add(mark.stopId);
      lastEnd = start + width;
    }
  }
  return shown;
}
