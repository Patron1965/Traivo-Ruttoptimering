import assert from "node:assert/strict";
import test from "node:test";
import {
  assertDraftState,
  DRAFT_BODY_MAX_BYTES,
  DRAFT_STATE_MAX_BYTES,
  PlanningDraftError,
} from "./planning-draft-service";

test("resumable operational import retains all source rows within the draft size limits", () => {
  const headers = Array.from({ length: 18 }, (_, column) => `Kolumn ${column + 1}`);
  const rows = Array.from({ length: 8660 }, (_, index) => ({
    sourceRowNumber: index + 2,
    values: headers.map((_, column) => `rad-${index + 1}-kolumn-${column + 1}-värde`),
  }));
  const state = {
    step: 2,
    parsedData: { headers, rows, sourceRowCount: rows.length },
  };
  assert.ok(Buffer.byteLength(JSON.stringify(state), "utf8") > 512 * 1024);
  assertDraftState(state);
  assert.ok(Buffer.byteLength(JSON.stringify({ revision: 0, state }), "utf8") < DRAFT_BODY_MAX_BYTES);
  assert.equal(state.parsedData.rows.at(-1)?.values.length, 18);
  assert.equal(state.parsedData.rows.at(-1)?.sourceRowNumber, 8661);
});

test("oversize drafts fail explicitly rather than discarding source rows", () => {
  assert.throws(
    () => assertDraftState({ parsedData: { rows: ["x".repeat(DRAFT_STATE_MAX_BYTES)] } }),
    (error: unknown) => error instanceof PlanningDraftError && error.code === "DRAFT_STATE_TOO_LARGE",
  );
});