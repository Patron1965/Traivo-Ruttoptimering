import assert from "node:assert/strict";
import test from "node:test";
import {
  createPredictionResponse,
  generatePredictions,
  getDefaultBoundsPredictionResponse,
} from "./prediction";

test("prediction responses declare their simulation-only contract", () => {
  const response = createPredictionResponse({
    lat1: 59.30,
    lng1: 18.04,
    lat2: 59.36,
    lng2: 18.10,
  }, 45);

  assert.deepEqual(response.metadata.source, "simulation");
  assert.deepEqual(response.metadata.mode, "simulation");
  assert.equal(response.metadata.isSimulation, true);
  assert.equal(response.metadata.horizonMinutes, 45);
  assert.match(response.metadata.generatedAt, /^\d{4}-\d{2}-\d{2}T/);
  assert.ok(Array.isArray(response.cells));
  assert.ok(response.cells.every((cell) => !("confidence" in cell)));
});

test("prediction generation never exposes confidence claims", () => {
  const cells = generatePredictions({
    lat1: 59.30,
    lng1: 18.04,
    lat2: 59.36,
    lng2: 18.10,
  });

  assert.ok(cells.every((cell) => !("confidence" in cell)));
});

test("default prediction response uses simulation metadata", () => {
  const response = getDefaultBoundsPredictionResponse();

  assert.equal(response.metadata.isSimulation, true);
  assert.equal(response.metadata.source, "simulation");
});