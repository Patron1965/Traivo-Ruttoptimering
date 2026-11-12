/**
 * Read-only road-distance comparison. Input CSV: sequence_order,latitude,longitude.
 * Does not write plans or claim feasibility of a reordered route.
 * Usage: tsx diagnose-route-order.ts csv startLat startLon endLat endLon
 */
import { readFileSync } from "node:fs";
import { fetchGeoapifyMatrix } from "../../artifacts/api-server/src/services/geoapify-road";

async function main() {
  const [file, ...endpointText] = process.argv.slice(2);
  const endpoints = endpointText.map(Number);
  if (!file || endpoints.length !== 4 || endpoints.some(n => !Number.isFinite(n))) throw Error("CSV and four endpoint coordinates required");
  const rows = readFileSync(file, "utf8").trim().split("\n").slice(1)
    .map(line => line.split(",").map(Number));
  const points = [
    { lat: endpoints[0], lon: endpoints[1] },
    ...rows.map(row => ({ lat: row[1], lon: row[2] })),
    { lat: endpoints[2], lon: endpoints[3] },
  ];
  const n = points.length;
  const distance = Array.from({ length: n }, () => Array<number>(n).fill(NaN));
  const duration = Array.from({ length: n }, () => Array<number>(n).fill(NaN));
  for (let s = 0; s < n; s += 31) for (let t = 0; t < n; t += 31) {
    const matrix = await fetchGeoapifyMatrix(points.slice(s, s + 31), points.slice(t, t + 31));
    matrix.distances.forEach((row, i) => row.forEach((value, j) => {
      const time = matrix.durations[i][j];
      if (value === null || time === null) throw Error("Unreachable matrix cell");
      distance[s + i][t + j] = value;
      duration[s + i][t + j] = time;
    }));
  }
  const sum = (route: number[], matrix: number[][]) => route.slice(1)
    .reduce((total, target, i) => total + matrix[route[i]][target], 0);
  const original = Array.from({ length: n }, (_, i) => i);
  const remaining = new Set(original.slice(1, -1));
  let candidate = [0];
  while (remaining.size) {
    const previous = candidate.at(-1)!;
    const next = [...remaining].sort((a, b) => distance[previous][a] - distance[previous][b])[0];
    candidate.push(next); remaining.delete(next);
  }
  candidate.push(n - 1);
  // Directed full-path scoring, not a symmetric 2-opt shortcut.
  for (let pass = 0; pass < 20; pass++) {
    let best = candidate;
    let bestCost = sum(candidate, distance);
    for (let i = 1; i < n - 2; i++) for (let j = i + 1; j < n - 1; j++) {
      const proposal = [...candidate.slice(0, i), ...candidate.slice(i, j + 1).reverse(), ...candidate.slice(j + 1)];
      const cost = sum(proposal, distance);
      if (cost < bestCost - 0.01) { best = proposal; bestCost = cost; }
    }
    if (best === candidate) break;
    candidate = best;
  }
  console.log(JSON.stringify({
    stops: rows.length,
    originalKm: sum(original, distance) / 1000, originalDrivingMin: sum(original, duration) / 60,
    comparisonKm: sum(candidate, distance) / 1000, comparisonDrivingMin: sum(candidate, duration) / 60,
    sameStopsAndEndpoints: candidate.length === n && new Set(candidate).size === n && candidate[0] === 0 && candidate.at(-1) === n - 1,
    feasibilityChecked: false, saved: false,
  }, null, 2));
}
main().then(() => process.exit(0)).catch(() => { console.error("Road comparison failed; no plan changed."); process.exit(1); });
