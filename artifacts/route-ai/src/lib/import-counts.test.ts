import assert from "node:assert/strict";
import test from "node:test";
import {
  readImportEvidence,
  resolveImportCounts,
  resolveImportOrderCount,
} from "./import-counts.ts";

test("resumed imports use persisted row evidence even when local parsed state exists", () => {
  const result = resolveImportCounts({
    importedResult: {
      receivedRowCount: 228,
      savedRowCount: 228,
      stopIds: Array.from({ length: 228 }, (_, index) => `stop-${index}`),
    },
    parsedSourceRowCount: 228,
    hasParsedSourceState: true,
    localReceivedRowCount: 0,
    localSavedRowCount: 0,
    manualSelectedCount: 0,
  });

  assert.deepEqual(result, { read: 228, saved: 228 });
});

test("import evidence prefers persisted stop IDs over embedded snapshots", () => {
  const evidence = readImportEvidence({
    receivedRowCount: 2,
    savedRowCount: 2,
    stopIds: ["stop-1", "stop-1", "stop-2"],
    stops: [{ id: "snapshot-1" }],
  });

  assert.deepEqual(evidence.stopIds, ["stop-1", "stop-2"]);
});

test("import order count does not add unplanned stops twice", () => {
  assert.equal(
    resolveImportOrderCount({
      importedStopIds: ["stop-1", "stop-2", "stop-2"],
      importedTotal: 228,
      fallbackCount: 0,
    }),
    2,
  );
  assert.equal(
    resolveImportOrderCount({
      importedStopIds: [],
      importedTotal: 228,
      fallbackCount: 0,
    }),
    228,
  );
});