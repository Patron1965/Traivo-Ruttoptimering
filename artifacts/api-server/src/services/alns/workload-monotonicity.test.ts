import assert from "node:assert/strict";
import { test } from "node:test";
import { compareSolutionScores, computeSolutionCost } from "./cost";
import { planningProfileWeights } from "./planning-profiles";
import type { ALNSRoute, ALNSSolution, ALNSVehicle, OptimizationWeights, RouteEvaluation } from "./types";

const start = new Date("2026-11-11T07:00:00Z");
const vehicles: ALNSVehicle[] = ["one", "two", "three"].map(id => ({
  id, vehicleType: "fossil", capacityKg: 1000, capacityVolume: 100, rangeKm: null,
}));
const routes: ALNSRoute[] = vehicles.map((v, i) => ({
  vehicleId: v.id, totalWeight: 1, totalVolume: 1,
  nodes: [{ id: v.id, latitude: 59 + i / 100, longitude: 18,
    weightKg: 1, volumeM3: 1, serviceDurationMin: 10,
    timeWindowStart: null, timeWindowEnd: null }],
}));
const weights: OptimizationWeights = {
  distanceWeight: 1, co2Weight: 0, etaPrecisionWeight: 0,
  driverHappinessWeight: 0, geographicCohesionWeight: 0,
};

test("all five named profiles reject adding distance merely to equalize workdays", () => {
  for (const name of ["balanced", "shortest", "geographic", "areas_worktime", "minimize_vehicles"] as const) {
    const weights = planningProfileWeights(name);
    assert.ok(compareSolutionScores(score([70, 440, 440], 100, weights), score([440, 440, 440], 400, weights)) < 0, name);
  }
});

test("resource eligibility alone adds no hidden vehicle cost to shortest driving", () => {
  const weights = planningProfileWeights("shortest");
  assert.equal(compareSolutionScores(score([70, 440, 440], 100, weights, "balance"),
    score([70, 440, 440], 100, weights, "minimize")), 0);
});

// Controlled canonical-evaluation cache isolates the objective from routing:
// ownership, feasibility, service, and every other penalty stay identical.
function score(minutes: number[], km: number, options = weights, mode: "balance" | "minimize" = "balance") {
  const evaluations = new WeakMap<ALNSRoute, RouteEvaluation>();
  routes.forEach((route, i) => evaluations.set(route, {
    feasible: true, actualWorkMinutes: minutes[i], totalDistanceKm: km / routes.length,
    totalCo2Kg: 0, totalTimeWindowSlackMin: 0,
    endTime: new Date(start.getTime() + minutes[i] * 60_000),
    rangeUsedKm: 0, chargingInsertions: 0, driverPenalty: 0,
  }));
  return computeSolutionCost({ routes, unassigned: [] } as unknown as ALNSSolution,
    vehicles, 59, 18, start, options, undefined, mode, { evaluations, geographicCohesionCost: 0 });
}

test("extra driving cannot improve balance, even when it equalizes workdays", () => {
  const efficient = score([70, 440, 440], 100);
  const detour = score([440, 440, 440], 400);
  assert.ok(efficient.cost < detour.cost);
  for (let minutes = 70; minutes <= 500; minutes += 10) {
    assert.ok(score([minutes, 440, 440], 100 + minutes).cost <
      score([minutes + 1, 440, 440], 101 + minutes).cost);
  }
});

test("explicit areas objective also rejects equalizing detours", () => {
  const areas: OptimizationWeights = { ...weights, objectivePriority: "areas_worktime" };
  assert.ok(compareSolutionScores(
    score([70, 440, 440], 100, areas), score([440, 440, 440], 400, areas),
  ) < 0);
});

test("workload balancing is independent of selected resource occupancy", () => {
  const geographic = { ...weights, geographicCohesionWeight: 0.5, workloadBalanceWeight: 0 };
  assert.equal(score([70, 440, 440], 100, geographic).cost, 100);
  assert.equal(score([440, 440, 440], 100, geographic).cost, 100);
  assert.equal(score([70, 440, 440], 100, geographic, "minimize").cost, 3100);
});
