import assert from "node:assert/strict";
import { test } from "node:test";
import { buildDriverExecutionRequest } from "./driver-execution-request.ts";

test("web driver sends every terminal status through the execution-event endpoint", () => {
  for (const status of ["completed", "failed", "skipped"]) {
    const request = buildDriverExecutionRequest({
      apiBase: "",
      stopId: "stop/one",
      status,
      planVersion: 7,
      clientEventId: `event-${status}`,
      occurredAt: "2026-09-07T10:00:00.000Z",
      details: status === "skipped"
        ? { skipReason: "CUSTOMER_UNAVAILABLE", comment: "Ingen hemma" }
        : {},
    });

    assert.equal(request.url, "/api/stops/stop%2Fone/execution-events");
    assert.equal(request.init.method, "POST");
    assert.deepEqual(JSON.parse(request.init.body), {
      clientEventId: `event-${status}`,
      type: status,
      planVersion: 7,
      occurredAt: "2026-09-07T10:00:00.000Z",
      ...(status === "skipped"
        ? { skipReason: "CUSTOMER_UNAVAILABLE", comment: "Ingen hemma" }
        : {}),
    });
  }
});