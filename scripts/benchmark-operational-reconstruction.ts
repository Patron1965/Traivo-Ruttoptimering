/**
 * Read-only, isolated reconstruction benchmark. Run with scripts/node_modules/.bin/tsx.
 * Input and all raw provider responses MUST remain under /tmp.
 * No usage context is installed: canonical routing helpers cannot write usage records.
 * A durable attempt ledger caps the entire warmup, including failed requests, at 64.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { optimizeWithALNS } from "../artifacts/api-server/src/services/alns/runner";
import { computeGeographicCohesionCost, evaluateRoute } from "../artifacts/api-server/src/services/alns/cost";
import { evaluateRouteWorkday } from "../artifacts/api-server/src/services/route-workday";
import { withRequiredRoadData } from "../artifacts/api-server/src/services/road-data-policy";
import { precomputeDistanceMatrix, getDistanceMatrixCacheCoverage } from "../artifacts/api-server/src/services/osrm";
import { operationalProviderKind, operationalProviderConfigured } from "../artifacts/api-server/src/services/operational-provider-config";
import type { ALNSNode, ALNSVehicle, ALNSDriverConstraints, OptimizationWeights, ALNSRoute } from "../artifacts/api-server/src/services/alns/types";

const inputPath = process.argv[2];
const cacheDir = process.argv[3];
if (!inputPath?.startsWith("/tmp/") || !cacheDir?.startsWith("/tmp/")) {
  throw new Error("Usage: benchmark-operational-reconstruction.ts /tmp/input.json /tmp/cache-directory");
}
mkdirSync(cacheDir, { recursive: true, mode: 0o700 });
const inputBytes = readFileSync(inputPath);
const inputHash = createHash("sha256").update(inputBytes).digest("hex");
const snapshot = JSON.parse(inputBytes.toString());
const save = (name: string, value: unknown) => writeFileSync(`${cacheDir}/${name}`, JSON.stringify(value), { mode: 0o600 });
const org = snapshot.organization;
if (snapshot.inputs.objective !== "balanced" || snapshot.inputs.vehicleSelectionMode !== "use_all_selected_pairs" ||
    snapshot.rows.length !== 228 || snapshot.resources.length !== 9 ||
    !org.startVerified || !org.endVerified || !Number.isFinite(org.serviceMin) ||
    snapshot.roadPolicy && !["inherit", "geoapify"].includes(snapshot.roadPolicy.roadProvider)) {
  throw new Error("Input/policy differs from the authorized reconstruction");
}
if (operationalProviderKind() !== "geoapify" || !operationalProviderConfigured()) throw new Error("Approved provider unavailable");
const nodes: ALNSNode[] = snapshot.rows.map((row: any, i: number) => {
  if (row.jobType !== "delivery" || !Number.isFinite(Number(row.latitude)) || !Number.isFinite(Number(row.longitude)) ||
      Math.abs(Number(row.latitude)) > 90 || Math.abs(Number(row.longitude)) > 180) throw new Error("Invalid mapped delivery");
  return { id: `stop-${i + 1}`, latitude: Number(row.latitude), longitude: Number(row.longitude),
    jobType: "delivery", timeWindowStart: null, timeWindowEnd: null,
    serviceDurationMin: org.serviceMin, weightKg: 0, volumeM3: 0,
    stopReserveMin: snapshot.inputs.stopReserveMin, travelReservePercent: snapshot.inputs.travelReservePercent };
});
const constraints: ALNSDriverConstraints[] = [];
const vehicles: ALNSVehicle[] = snapshot.resources.map((resource: any, i: number) => {
  const d = resource.driver, v = resource.vehicle, id = `resource-${i + 1}`;
  if (!d?.is_active || !v?.is_active || d.vehicle_id !== v.id || v.vehicle_type !== "fossil" ||
      !d.work_start_time || !d.work_end_time || resource.preferences) throw new Error("Unexpected resource facts");
  // Same defaults as import-route-workflow.routingConstraintsForDriver, not inferred preferences.
  const constraint: ALNSDriverConstraints = { vehicleId: id, driverName: id,
    preferredStartTime: d.work_start_time, preferredEndTime: d.work_end_time,
    maxDrivingHoursPerDay: 8, avoidNightDriving: false,
    breakFrequencyMinutes: 120, preferredBreakDurationMin: 15,
    breakStartTime: d.break_start_time, breakEndTime: d.break_end_time };
  constraints.push(constraint);
  return { id, driverId: id, vehicleType: v.vehicle_type, rangeKm: v.range_km,
    capacityKg: d.capacity_kg == null ? v.capacity_kg : Math.min(v.capacity_kg, d.capacity_kg),
    capacityVolume: d.capacity_volume == null ? v.capacity_volume : Math.min(v.capacity_volume, d.capacity_volume),
    startLatitude: d.start_latitude ?? org.startLat, startLongitude: d.start_longitude ?? org.startLon,
    endLatitude: d.end_latitude ?? org.endLat, endLongitude: d.end_longitude ?? org.endLon,
    tempoMultiplier: d.tempo === "slow" ? 1.15 : d.tempo === "fast" ? 0.9 : 1,
    maxDriverOvertimeMin: snapshot.inputs.maxDriverOvertimeMin ?? org.overtimeMin ?? 0,
    allowLateStopsMin: snapshot.inputs.allowLateStopsMin ?? org.lateMin ?? 0,
    travelReservePercent: snapshot.inputs.travelReservePercent, canonicalDriverConstraints: constraint };
});
const coords = [{ lat: org.startLat, lon: org.startLon },
  ...vehicles.flatMap(v => [{ lat: v.startLatitude!, lon: v.startLongitude! }, { lat: v.endLatitude!, lon: v.endLongitude! }]),
  ...nodes.map(n => ({ lat: n.latitude, lon: n.longitude }))];
const uniqueCount = new Set(coords.map(p => `${Math.round(p.lat * 1e5)},${Math.round(p.lon * 1e5)}`)).size;
if (Math.ceil(uniqueCount / 31) ** 2 > 64) throw new Error("Matrix exceeds authorized request budget");
const ledgerPath = `${cacheDir}/ledger.json`;
const ledger = existsSync(ledgerPath) ? JSON.parse(readFileSync(ledgerPath, "utf8")) : { inputHash, attempts: 0, blocks: {} };
if (ledger.inputHash !== inputHash) throw new Error("Matrix/input identity mismatch");
const nativeFetch = globalThis.fetch;
let offline = false;
let replayed = 0;
globalThis.fetch = async (input, options) => {
  if (offline) throw new Error("External fetch forbidden during optimization");
  const url = new URL(String(input));
  if (url.origin !== "https://api.geoapify.com" || url.pathname !== "/v1/routematrix" ||
      options?.method !== "POST" || typeof options.body !== "string") throw new Error("Unapproved external request");
  const key = createHash("sha256").update(options.body).digest("hex");
  const filename = `${key}.json`;
  if (ledger.blocks[key] === "complete") {
    replayed++;
    return new Response(readFileSync(`${cacheDir}/${filename}`, "utf8"), { status: 200 });
  }
  if (ledger.blocks[key] || ledger.attempts >= 64) throw new Error("No retries; provider budget exhausted or prior block failed");
  ledger.attempts++;
  ledger.blocks[key] = "attempted";
  save("ledger.json", ledger);
  const response = await nativeFetch(input, { ...options, redirect: "error" });
  if (!response.ok) throw new Error("Provider request failed; no retry");
  const text = await response.text();
  JSON.parse(text);
  writeFileSync(`${cacheDir}/${filename}`, text, { mode: 0o600 });
  ledger.blocks[key] = "complete";
  save("ledger.json", ledger);
  console.log(`Matrix block ${ledger.attempts}/64 saved`);
  return new Response(text, { status: 200 });
};

async function main() {
  const warmStart = performance.now();
  const complete = await precomputeDistanceMatrix(coords, { timeoutMs: 30000 });
  const coverage = getDistanceMatrixCacheCoverage(coords);
  const warmupMs = performance.now() - warmStart;
  offline = true;
  if (!complete || !coverage.complete) throw new Error("Incomplete verified road matrix; benchmark forbidden");
  const manifest = { inputHash, uniqueCount, coverage, warmupMs, externalAttempts: ledger.attempts, replayed,
    responseDigest: createHash("sha256").update(Object.keys(ledger.blocks).sort().map(key =>
      readFileSync(`${cacheDir}/${key}.json`)).map(bytes => createHash("sha256").update(bytes).digest("hex")).join("")).digest("hex") };
  save("manifest.json", manifest);
  const outputs: any[] = [];
  for (const objective of ["balanced", "areas_worktime"] as const) {
    // One identical seed, no seed hunting. Wall-time bounded search can still vary by host load.
    let seed = 20261021;
    Math.random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
    const weights: OptimizationWeights = objective === "balanced"
      ? { distanceWeight: .35, co2Weight: .15, etaPrecisionWeight: .15, driverHappinessWeight: .35, geographicCohesionWeight: 0 }
      : { objectivePriority: "areas_worktime", distanceWeight: 0, co2Weight: 0, etaPrecisionWeight: 0, driverHappinessWeight: 0, geographicCohesionWeight: 1 };
    const start = new Date(snapshot.startAt);
    const begun = performance.now();
    const result = await optimizeWithALNS(structuredClone(nodes), structuredClone(vehicles), org.startLat, org.startLon, start,
      { weights, driverConstraints: structuredClone(constraints), vehicleDistributionMode: "balance",
        timeLimitMs: 15000, maxIterations: 1000, localSearchTimeLimitMs: 1000, distanceMatrixTimeoutMs: 1 });
    const optimizerWallMs = performance.now() - begun;
    const metrics = withRequiredRoadData(() => vehicles.map(v => {
      const route = result.routes.find(r => r.vehicleId === v.id) ?? { vehicleId: v.id, nodes: [], totalWeight: 0, totalVolume: 0 };
      const evaluation = evaluateRoute(route, v, org.startLat, org.startLon, start, v.canonicalDriverConstraints);
      const workday = evaluateRouteWorkday(route.nodes, v, org.startLat, org.startLon, start, v.canonicalDriverConstraints);
      const s = workday.summary;
      return { resource: v.id, stops: route.nodes.filter(n => !n.isChargingStation).length,
        feasible: evaluation.feasible && workday.feasible, reason: workday.reasonCode ?? null,
        shiftStart: v.canonicalDriverConstraints!.preferredStartTime, shiftEnd: v.canonicalDriverConstraints!.preferredEndTime,
        distanceKm: evaluation.totalDistanceKm, drivingMin: s.nonReturnDrivingMin + s.returnMin,
        serviceMin: s.serviceMin, workMin: s.nonReturnDrivingMin + s.returnMin + s.serviceMin,
        breakMin: s.breakMin, waitingMin: s.waitingMin, totalMin: s.totalMin, marginMin: s.marginMin, overtimeMin: s.overtimeMin };
    }));
    const diagnosticsStarted = performance.now();
    // Exhaustively check single-stop insertion into the final routes; this is not proof about global reassignment.
    const unplannedReasons: Record<string, number> = {};
    withRequiredRoadData(() => {
      for (const node of result.unassigned) {
        const reasons = new Set<string>();
        let insertable = false;
        for (const v of vehicles) {
          const route = result.routes.find(r => r.vehicleId === v.id) ?? { vehicleId: v.id, nodes: [], totalWeight: 0, totalVolume: 0 };
          for (let pos = 0; pos <= route.nodes.length; pos++) {
            const inserted: ALNSRoute = { ...route, nodes: [...route.nodes.slice(0, pos), node, ...route.nodes.slice(pos)],
              totalWeight: route.totalWeight + node.weightKg, totalVolume: route.totalVolume + node.volumeM3 };
            const evaluation = evaluateRoute(inserted, v, org.startLat, org.startLon, start, v.canonicalDriverConstraints);
            const workday = evaluateRouteWorkday(inserted.nodes, v, org.startLat, org.startLon, start, v.canonicalDriverConstraints);
            if (evaluation.feasible && workday.feasible) insertable = true;
            else reasons.add(workday.reasonCode ?? "OTHER_ROUTE_CONSTRAINT");
          }
        }
        const reason = insertable ? "FEASIBLE_SINGLE_INSERTION_REMAINS" : [...reasons].sort().join("+");
        unplannedReasons[reason] = (unplannedReasons[reason] ?? 0) + 1;
      }
    });
    const assigned = result.routes.flatMap(r => r.nodes.filter(n => !n.isChargingStation).map(n => n.id));
    if (new Set(assigned).size !== assigned.length || assigned.length + result.unassigned.length !== nodes.length) throw new Error("Coverage integrity failed");
    const entry = { objective, optimizerWallMs, diagnosticsMs: performance.now() - diagnosticsStarted,
      assigned: assigned.length, unassigned: result.unassigned.length, selectedResources: vehicles.length,
      usedResources: metrics.filter(m => m.stops > 0).length, feasible: metrics.every(m => m.feasible),
      cohesionPenalty: computeGeographicCohesionCost(result.routes), metrics, unplannedReasons,
      costBreakdown: result.costBreakdown, performance: result.performance,
      workSpreadMin: Math.max(...metrics.map(m => m.workMin)) - Math.min(...metrics.map(m => m.workMin)) };
    outputs.push(entry);
    save("results.json", { reconstruction: true, manifest, config: { searchMs: 15000, maxIterations: 1000, localSearchMs: 1000, seed: 20261021 }, outputs });
    console.log(JSON.stringify({ objective, optimizerWallMs, assigned: entry.assigned, unassigned: entry.unassigned, feasible: entry.feasible }));
  }
}
main().then(() => process.exit(0)).catch(() => {
  // Deliberately avoid dumping provider errors or request URLs.
  console.error("Reconstruction benchmark failed closed. Inspect private ledger/partial results; no automatic retry.");
  process.exit(1);
});
