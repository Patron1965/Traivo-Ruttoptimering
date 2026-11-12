import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const bulk = readFileSync(new URL("../components/dispatch/DispatchBulkActions.tsx", import.meta.url), "utf8");
const drag = readFileSync(new URL("../hooks/use-direct-dispatch-drag.ts", import.meta.url), "utf8");
const service = readFileSync(new URL("../../../api-server/src/services/stop-service.ts", import.meta.url), "utf8");

test("preview execution and progress use the same eligibility gate", () => {
  assert.match(bulk, /const previewAllowed = Boolean\([\s\S]*?!lockedStops && !sourceUnavailable/);
  assert.match(bulk, /if \(!previewAllowed\) return/);
  assert.match(bulk, /\{previewAllowed && \(/);
  assert.ok(bulk.indexOf("setRoutePreview(null)") < bulk.indexOf("if (!previewAllowed) return"));
});

test("confirmed route moves keep selection and direct moves announce pending state", () => {
  assert.match(bulk, /if \(action !== "route"\) setSelectedStopIds\(new Set\(\)\)/);
  assert.match(drag, /if \(routeId === null\) initial.select\(new Set\(\)\)/);
  assert.match(drag, /Ingen ändring är sparad ännu/);
});

test("lifecycle rejection precedes road preparation without removing transactional checks", () => {
  const move = service.slice(service.indexOf("export async function moveStopsForDispatch"));
  assert.ok(move.indexOf("const earlyLockedStop") < move.indexOf("await prepareDispatchLockRoadData"));
  assert.match(move, /const movingLockedStop = movingSnapshot.find/);
  assert.match(move, /const earlyStops =[\s\S]*?eq\(stopsTable.organizationId, organizationId\)/);
});
