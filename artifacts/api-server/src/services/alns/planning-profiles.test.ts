import test from "node:test";
import assert from "node:assert/strict";
import { planningProfileWeights, usesRoadSeed } from "./planning-profiles";
import { compareSolutionScores } from "./cost";
import type { CostBreakdown } from "./types";
import type { ALNSNode } from "./types";
import { roadMedoidClusters } from "./profile-clustering";
import { withRequiredRoadData, RoadDataUnavailableError } from "../road-data-policy";

test("road medoids preserve every job at repeated coordinates", () => {
  const nodes = ["d", "a", "c", "b"].map(id => ({ id, latitude: 0, longitude: 0 }) as ALNSNode);
  const grouped = roadMedoidClusters(nodes, 2);
  assert.deepEqual(grouped.clusters.flat().map(n => n.id).sort(), ["a", "b", "c", "d"]);
  assert.deepEqual(roadMedoidClusters([...nodes].reverse(), 2), grouped);
});

test("operational road seeding fails closed without road evidence", () => {
  const nodes = [{ id: "x", latitude: -80, longitude: -170 }, { id: "y", latitude: -79, longitude: -169 }] as ALNSNode[];
  assert.throws(() => withRequiredRoadData(() => roadMedoidClusters(nodes, 1)), RoadDataUnavailableError);
});

test("named goals do not infer workload balancing or fixed fleet cost from resource occupancy", () => {
  for (const name of ["shortest", "geographic", "minimize_vehicles"] as const)
    assert.equal(planningProfileWeights(name).workloadBalanceWeight, 0);
  assert.equal(planningProfileWeights("shortest").distanceWeight, 1);
  assert.equal(planningProfileWeights("shortest").co2Weight, 0);
  assert.equal(usesRoadSeed("shortest"), true);
  assert.equal(usesRoadSeed("balanced"), true);
  assert.equal(usesRoadSeed("minimize_vehicles"), true);
  assert.equal(usesRoadSeed("geographic"), true);
  assert.equal(usesRoadSeed("areas_worktime"), false);
});

test("hard validity and coverage outrank arbitrarily attractive objective values", () => {
  const score = (profileScore: number[], cost: number) => ({
    cost, breakdown: { profileScore } as CostBreakdown,
  });
  assert.ok(compareSolutionScores(score([0, 0, 0, 0, 999], 999999), score([1, 0, 0, 0, 1], 1)) < 0);
  assert.ok(compareSolutionScores(score([0, 0, 0, 0, 999], 999999), score([0, 0, 0, 1, 1], 1)) < 0);
  assert.ok(compareSolutionScores(score([0, 0, 0, 0, 10, 50], 999), score([0, 0, 0, 0, 11, 1], 1)) < 0);
});
