import assert from "node:assert/strict";
import { test } from "node:test";
import { CreateStopBody, ImportStopsBody, UpdateStopBody } from "@workspace/api-zod";

const organizationId = "00000000-0000-0000-0000-000000000001";
const customerId = "00000000-0000-0000-0000-000000000002";

test("CreateStopBody parses a constrained customer stop planning date as a Date", () => {
  const result = CreateStopBody.safeParse({
    organizationId,
    customerId,
    planningDate: "2026-03-29",
    address: "Kundgatan 1",
    latitude: 59.33,
    longitude: 18.07,
  });

  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  if (!result.success) return;
  assert.equal(result.data.customerId, customerId);
  assert.ok(result.data.planningDate instanceof Date);
  assert.equal(result.data.planningDate?.toISOString(), "2026-03-29T00:00:00.000Z");
});

test("ImportStopsBody preserves customerId and coerces each row planning date", () => {
  const result = ImportStopsBody.safeParse({
    organizationId,
    expectedRowCount: 1,
    stops: [{
      customerId,
      planningDate: "2026-03-29",
      address: "Kundgatan 1",
    }],
  });

  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  if (!result.success) return;
  const stop = result.data.stops[0];
  assert.equal(stop.customerId, customerId);
  assert.ok(stop.planningDate instanceof Date);
  assert.equal(stop.planningDate?.toISOString(), "2026-03-29T00:00:00.000Z");
});

test("UpdateStopBody parses an unassigned stop planning date as a Date", () => {
  const result = UpdateStopBody.safeParse({
    planningDate: "2026-03-29",
  });

  assert.equal(result.success, true, JSON.stringify(result.error?.issues));
  if (!result.success) return;
  assert.ok(result.data.planningDate instanceof Date);
  assert.equal(result.data.planningDate?.toISOString(), "2026-03-29T00:00:00.000Z");
});