import { stockholmClock } from "./route-workday";

/** Calendar identity stays the API's UTC date-only value. Database bounds are
 * Swedish midnights, not UTC midnights or an assumed 24-hour duration. */
export function stockholmPlanningDayBounds(date: Date): { dayStart: Date; dayEnd: Date } {
  if (!Number.isFinite(date.getTime())) throw new Error("Ogiltigt planeringsdatum.");
  const next = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1));
  return { dayStart: stockholmClock(date, "00:00"), dayEnd: stockholmClock(next, "00:00") };
}
