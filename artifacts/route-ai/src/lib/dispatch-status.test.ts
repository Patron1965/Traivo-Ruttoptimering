import assert from "node:assert/strict";
import { test } from "node:test";
import { getStopVisualStatus, SLA_RISK_MARGIN_MINUTES } from "./dispatch-status.ts";

test("SLA risk starts below 30 minutes, not at 30 or 60", () => {
  assert.equal(SLA_RISK_MARGIN_MINUTES, 30);
  const timeWindowEnd = "2026-09-16T15:00:00Z";
  for (const [arrival, expected] of [
    ["14:00", "planned"],
    ["14:29", "planned"],
    ["14:30", "planned"],
    ["14:31", "sla_risk"],
    ["15:01", "sla_risk"],
  ] as const) {
    assert.equal(getStopVisualStatus({
      status: "pending", timeWindowEnd,
      arrivalTime: new Date(`2026-09-16T${arrival}:00Z`),
    }), expected);
  }
});