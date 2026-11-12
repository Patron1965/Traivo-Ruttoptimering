import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("./GanttPopout.tsx", import.meta.url), "utf8");

test("Gantt popout wires timeline moves to persisted reassignment and drag handlers", () => {
  assert.match(source, /onReassignStops=\{canEdit \? handleReassignStops : undefined\}/);
  assert.match(source, /startDrag=\{[^}]+\}/);
  assert.match(source, /dragState=\{(?!null)[^}]+\}/);
  assert.doesNotMatch(source, /startDrag=\{\(\) => \{\}\}/);
  assert.doesNotMatch(source, /Stops can’t be moved in the popped-out timeline\./);
  assert.doesNotMatch(source, /Stopp kan inte flyttas i den utfällda tidslinjen\./);
});

test("Gantt popout carries route dates and sorts route rows before adding the unplanned row", () => {
  assert.match(source, /routeDate:\s*route\.date \?\? null/);
  const sortIndex = source.indexOf("sortScheduledRows(routeRows)");
  const unplannedIndex = source.indexOf("if (unassignedStops.length > 0)");
  assert.ok(sortIndex >= 0, "route rows should use the shared scheduled-row order");
  assert.ok(unplannedIndex > sortIndex, "the unplanned row should be appended after sorting route rows");
  assert.match(source, /return sortedRouteRows/);
});