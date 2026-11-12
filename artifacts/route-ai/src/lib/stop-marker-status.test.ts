import test from "node:test";
import assert from "node:assert/strict";
import { stopMarkerStatusBadge } from "./stop-marker-status";

test("completed stops show a labelled check independently of route colour and selection", () => {
  const badge = stopMarkerStatusBadge("completed");
  assert.match(badge, /data-stop-status="completed"/);
  assert.match(badge, /aria-label="Utfört"/);
  assert.match(badge, /✓/);
});
test("pending, failed, skipped and unknown stops never show completion", () => {
  for (const status of ["pending", "in_progress", "failed", "skipped", undefined]) {
    assert.equal(stopMarkerStatusBadge(status), "");
  }
});
