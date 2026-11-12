import assert from "node:assert/strict";
import test from "node:test";
import type { MappedRow } from "./types.ts";
import {
  filterMappedRows,
  getImportRowStatus,
  reconcileImportReviewCounts,
  updateMappedRowById,
  validateMappedRow,
} from "./import-review.ts";
import { getImportReviewCopy } from "./import-review-copy.ts";

function row(overrides: Partial<MappedRow> = {}): MappedRow {
  return {
    _id: "row-1",
    _sourceRowNumber: 2,
    _sourceValues: ["ORD-1", "2026-04-10", "Storgatan 1"],
    address: "Storgatan 1",
    date: "2026-04-10",
    ...overrides,
  };
}

test("multiple validation errors count as one action row", () => {
  const invalid = row({
    _mappingErrors: ["Invalid number", "Invalid date"],
    weightKg: -1,
    volumeM3: -2,
    timeWindowStart: "12:00",
    timeWindowEnd: "08:00",
  });

  assert.equal(validateMappedRow(invalid).length, 5);
  assert.deepEqual(
    reconcileImportReviewCounts([invalid], []).action,
    1,
  );
  assert.equal(reconcileImportReviewCounts([invalid], []).total, 1);
  assert.equal(reconcileImportReviewCounts([invalid], []).ready, 0);
});

test("delivery and pickup address problems still represent one source row", () => {
  const unresolved = row({
    latitude: undefined,
    longitude: undefined,
    pickupAddress: "Terminalvägen 1",
    pickupLatitude: undefined,
    pickupLongitude: undefined,
  });
  const counts = reconcileImportReviewCounts([unresolved], [], {
    addressesResolved: true,
  });

  assert.equal(getImportRowStatus(unresolved, { addressesResolved: true }), "awaitingAddress");
  assert.equal(counts.total, 1);
  assert.equal(counts.ready, 0);
  assert.equal(counts.action, 1);
  assert.equal(counts.awaitingAddress, 1);
});

test("a candidate list never counts as accepted coordinates", () => {
  const candidateOnly = row({
    _deliveryCandidates: [{
      id: "candidate-1",
      latitude: 59.3,
      longitude: 18,
      displayName: "Storgatan 1, Stockholm",
      source: "nominatim",
      partial: true,
    }],
  });

  assert.equal(getImportRowStatus(candidateOnly, { addressesResolved: true }), "awaitingAddress");
  assert.equal(reconcileImportReviewCounts([candidateOnly], [], {
    addressesResolved: true,
  }).ready, 0);
});

test("a resolved delivery and pickup are both required for ready", () => {
  const resolved = row({
    latitude: 59.3,
    longitude: 18.0,
    pickupAddress: "Terminalvägen 1",
    pickupLatitude: 59.31,
    pickupLongitude: 18.01,
  });
  const counts = reconcileImportReviewCounts([resolved], [], {
    addressesResolved: true,
  });

  assert.equal(counts.ready, 1);
  assert.equal(counts.action, 0);
  assert.equal(counts.awaitingAddress, 0);
});

test("inline correction changes values but preserves row identity", () => {
  const invalid = row({ address: "", _mappingErrors: [] });
  const corrected = updateMappedRowById([invalid], "row-1", { address: "Ny gata 4" })[0];

  assert.equal(corrected._id, invalid._id);
  assert.equal(corrected._sourceRowNumber, invalid._sourceRowNumber);
  assert.equal(validateMappedRow(corrected).length, 0);
  assert.equal(reconcileImportReviewCounts([corrected]).ready, 1);
});

test("rejected source rows are unique and never double-counted with mapped rows", () => {
  const rejected = {
    sourceRowNumber: 2,
    values: ["ORD-1"],
    reasons: ["Address missing"],
  };
  const counts = reconcileImportReviewCounts(
    [row(), row({ _id: "duplicate", _sourceRowNumber: 2 })],
    [rejected, rejected],
  );

  assert.equal(counts.total, 1);
  assert.equal(counts.rejected, 1);
  assert.equal(counts.mapped, 0);
  assert.equal(counts.ready, 0);
});

test("problems-first filtering keeps valid rows awaiting address visible", () => {
  const ready = row({
    _id: "ready",
    _sourceRowNumber: 3,
    latitude: 59.3,
    longitude: 18,
  });
  const awaiting = row({
    _id: "awaiting",
    _sourceRowNumber: 4,
    latitude: undefined,
    longitude: undefined,
  });

  assert.deepEqual(
    filterMappedRows([ready, awaiting], "problems", { addressesResolved: true })
      .map((candidate) => candidate._id),
    ["awaiting"],
  );
  assert.deepEqual(
    filterMappedRows([ready, awaiting], "ready", { addressesResolved: true })
      .map((candidate) => candidate._id),
    ["ready"],
  );
  assert.deepEqual(
    filterMappedRows([ready, awaiting], "rejected", { addressesResolved: true }),
    [],
  );
});

test("review copy stays localized without mutating shared locale resources", () => {
  assert.equal(getImportReviewCopy("sv-SE").filters.problems, "Problem");
  assert.equal(getImportReviewCopy("en-US").filters.problems, "Problems");
  assert.equal(getImportReviewCopy("en-US").validation.addressMissing, "Delivery address is required.");
});