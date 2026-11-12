/**
 * Run with: tsx src/services/district-solver.bench.ts
 * Entire fixture uses synthetic coordinates around Göteborg and MOCK road costs/geometry.
 * No public OSRM service is contacted. Transport timings below are simulated in-process,
 * not measurements of real network or road coverage.
 */
import { performance } from "node:perf_hooks";
import { solveDistrict, type DistrictCoordinate, type DistrictRoadProvider } from "./district-solver";

const points = Array.from({ length: 500 }, (_, i) => ({
  id: `row-${i + 1}`, latitude: 57.64 + Math.floor(i / 25) * 0.003,
  longitude: 11.83 + (i % 25) * 0.004,
}));
const input = { points, start: { pointId: "row-1" }, mode: "loop" as const, serviceMinutes: 0 };
const callbacks = { onProgress: (_value: number) => {}, isCancelled: () => false };
const cost = (a: DistrictCoordinate, b: DistrictCoordinate) => (
  Math.abs(a.latitude - b.latitude) * 111_000 + Math.abs(a.longitude - b.longitude) * 61_000
) * (a.longitude <= b.longitude ? 1.1 : 1.3);

async function measure(label: string, provider: DistrictRoadProvider, warmMatrixCache: boolean) {
  let calls = 0, transportMs = 0, geometryCalls = 0;
  const metered: DistrictRoadProvider = {
    cacheKey: provider.cacheKey,
    async table(sources, destinations, signal) {
      calls++;
      const started = performance.now();
      const result = await provider.table(sources, destinations, signal);
      transportMs += performance.now() - started;
      return result;
    },
    async route(coords, signal) { geometryCalls++; return provider.route(coords, signal); },
  };
  const started = performance.now();
  const result = await solveDistrict(input, callbacks, { provider: metered, warmMatrixCache });
  const wallMs = performance.now() - started;
  if (result.orderedPointIds.length !== 500 || new Set(result.orderedPointIds).size !== 500)
    throw new Error("Benchmark lost stops.");
  console.log(JSON.stringify({
    label, stops: points.length, simulatedTableCalls: calls, geometryCalls,
    simulatedTransportMs: Math.round(transportMs), totalWallMs: Math.round(wallMs),
    approximateCpuAndOverheadMs: Math.round(wallMs - transportMs),
    note: "MOCK in-process cost and straight fixture geometry; not live OSRM or a road-distance SLA",
  }));
}
const mock: DistrictRoadProvider = {
  cacheKey: "district-bench-synthetic-v1",
  async table(sources, destinations) {
    return {
      distances: sources.map(a => destinations.map(b => cost(a, b))),
      durations: sources.map(a => destinations.map(b => cost(a, b) / 9)),
    };
  },
  async route(coords) { return { geometry: coords.map(p => ({ ...p })), waypoints: coords.map(p => ({ ...p })) }; },
};
await measure("cold mock matrix", mock, true);
await measure("warm mock matrix (same provider identity)", mock, true);