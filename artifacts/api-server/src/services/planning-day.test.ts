import assert from "node:assert/strict";
import { test } from "node:test";
import { stockholmPlanningDayBounds } from "./planning-day";

test("vehicle booking bounds include the Swedish early morning and exclude the following day", () => {
  const { dayStart, dayEnd } = stockholmPlanningDayBounds(new Date("2026-10-19T00:00:00Z"));
  assert.equal(dayStart.toISOString(), "2026-10-18T22:00:00.000Z");
  assert.equal(dayEnd.toISOString(), "2026-10-19T22:00:00.000Z");
  assert.ok(new Date("2026-10-18T23:30:00Z") >= dayStart);
  assert.ok(new Date("2026-10-19T22:30:00Z") >= dayEnd);
});

test("Swedish planning days span 25 hours in autumn and 23 hours in spring", () => {
  const autumn = stockholmPlanningDayBounds(new Date("2026-10-25T00:00:00Z"));
  assert.equal(autumn.dayStart.toISOString(), "2026-10-24T22:00:00.000Z");
  assert.equal(autumn.dayEnd.toISOString(), "2026-10-25T23:00:00.000Z");
  assert.equal(autumn.dayEnd.getTime() - autumn.dayStart.getTime(), 25 * 60 * 60_000);
  const spring = stockholmPlanningDayBounds(new Date("2026-03-29T00:00:00Z"));
  assert.equal(spring.dayEnd.getTime() - spring.dayStart.getTime(), 23 * 60 * 60_000);
});

test("booking days have exact non-overlapping half-open boundaries all year", () => {
  for (const value of ["2026-01-01", "2026-03-29", "2026-10-25", "2026-12-31"]) {
    const day = new Date(`${value}T00:00:00Z`);
    const { dayStart, dayEnd } = stockholmPlanningDayBounds(day);
    const next = new Date(day);
    next.setUTCDate(next.getUTCDate() + 1);
    assert.equal(dayEnd.getTime(), stockholmPlanningDayBounds(next).dayStart.getTime());
    const belongs = (instant: number) => instant >= dayStart.getTime() && instant < dayEnd.getTime();
    assert.equal(belongs(dayStart.getTime() - 1), false);
    assert.equal(belongs(dayStart.getTime()), true);
    assert.equal(belongs(dayEnd.getTime() - 1), true);
    assert.equal(belongs(dayEnd.getTime()), false);
  }
  assert.throws(() => stockholmPlanningDayBounds(new Date("invalid")));
});
