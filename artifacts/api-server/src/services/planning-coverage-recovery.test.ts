import assert from "node:assert/strict";
import { test, after } from "node:test";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { db, pool, organizationsTable } from "@workspace/db";
import { recoverPlanningCoverage } from "./planning-coverage-recovery";
import { type ALNSResult, type ALNSNode, type ALNSVehicle } from "./alns/types";

after(async () => { await pool.end(); });
const node = (id: string): ALNSNode => ({
  id, latitude: 59.3, longitude: 18, weightKg: 0, volumeM3: 0,
  serviceDurationMin: 1, timeWindowStart: null, timeWindowEnd: null,
});
const vehicle: ALNSVehicle = { id: "v", vehicleType: "fossil", capacityKg: 1000, capacityVolume: 100, rangeKm: null };
function result(nodes: ALNSNode[], missing: ALNSNode[]): ALNSResult {
  return {
    routes: [{ vehicleId: "v", nodes, totalWeight: 0, totalVolume: 0 }], unassigned: missing,
    routeEvaluations: new Map(),
    costBreakdown: { distanceCost: 0, co2Cost: 0, etaPrecisionCost: 0, driverPenaltyCost: 0, geographicCohesionCost: 0, totalDistanceKm: 0, totalCo2Kg: 0, totalTimeWindowSlackMin: 0, totalDriverPenalty: 0 },
    performance: { distanceMatrixMs: 0, clusteringMs: 0, alnsSearchMs: 0, mergingMs: 0, searchMs: 0, totalMs: 0, distanceSource: "cache" },
  };
}

test("a verified full-fleet incumbent prevents regression without changing the requested objective", async () => {
  const nodes = Array.from({ length: 101 }, (_, i) => node(`job-${i}`));
  const organizationId = randomUUID();
  await db.insert(organizationsTable).values({ id: organizationId, name: "Synthetic incumbent", email: "incumbent@example.test" });
  try {
  for (const mode of ["minimize", "balance"] as const) {
    const input = { organizationId, nodes, vehicles: [vehicle], constraints: new Map(), depotLatitude: 59.3, depotLongitude: 18,
      start: new Date("2026-10-19T06:00:00Z"), vehicleDistributionMode: mode };
    if (mode === "minimize") await recoverPlanningCoverage(result(nodes, []), input);
    const recovered = await recoverPlanningCoverage(result(nodes.slice(0, 100), nodes.slice(100)), input);
    assert.equal(recovered.unassigned.length, 0);
    assert.equal(new Set(recovered.routes.flatMap(r => r.nodes.map(n => n.id))).size, 101);
  }
  } finally { await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId)); }
});

test("invalid conservation is rejected and zero-budget recovery keeps the original valid result", async () => {
  const nodes = [node("a"), node("b")];
  const input = { nodes, vehicles: [vehicle], constraints: new Map(), depotLatitude: 59.3, depotLongitude: 18, start: new Date("2026-10-19T06:00:00Z"), vehicleDistributionMode: "balance" as const };
  await assert.rejects(recoverPlanningCoverage(result([nodes[0]], [nodes[0]]), input), /stopptäckning/);
  const original = result([nodes[0]], [nodes[1]]);
  assert.deepEqual((await recoverPlanningCoverage(original, input)).unassigned.map(n => n.id), ["b"]);
});
