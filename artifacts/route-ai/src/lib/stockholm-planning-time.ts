/** Rejects DST gaps and ambiguous repeated minutes rather than silently choosing an offset. */
export function stockholmPlanningMinuteToIso(value: string): string | null {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return null;
  const nominal = Date.parse(`${value}:00Z`);
  if (!Number.isFinite(nominal)) return null;
  const candidates = [60, 120].map(offset => new Date(nominal - offset * 60_000))
    .filter(date => stockholmPlanningMinute(date.toISOString()) === value);
  return candidates.length === 1 ? candidates[0].toISOString() : null;
}

export function stockholmPlanningMinute(value?: string | null): string {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  const parts = new Intl.DateTimeFormat("sv-SE", {
    timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit",
    day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (name: string) => parts.find(item => item.type === name)?.value;
  return `${part("year")}-${part("month")}-${part("day")}T${part("hour")}:${part("minute")}`;
}
