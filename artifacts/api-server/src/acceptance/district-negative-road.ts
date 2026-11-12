/**
 * Development-only, synthetic public-road fixture. No GTB rows, customer data,
 * database writes, geocoding, remote providers or operational routing settings.
 * Run from the repository root after starting district-private-osrm:
 * NODE_ENV=development pnpm --filter @workspace/api-server exec tsx src/acceptance/district-negative-road.ts
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { createReadStream } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createDistrictOsrmProvider, solveDistrict } from "../services/district-solver";

if (process.env.NODE_ENV !== "development" || process.env.REPLIT_DEPLOYMENT === "1")
  throw new Error("This road regression is development-only.");

const root = resolve(import.meta.dirname, "../../../..");
const dataset = resolve(root, ".cache/district-road/west-sweden.osrm.hsgr");
async function fileHash(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest("hex");
}
const datasetSha256 = await fileHash(dataset);
assert.equal(datasetSha256, "199529253ca594f1621df2faf670a8c591813e7a6fa16e630c6e94cecb27b050",
  "Fixture belongs to a pinned CH dataset. A new dataset requires separate regression acceptance.");
const engine = execFileSync("osrm-routed", ["--version"], { encoding: "utf8" }).trim();
assert.equal(engine, "v6.0.0");
// Interpolated synthetic positions on a public road, not source/customer stops.
const points = [
  { id: "synthetic-a", longitude: 11.9704006, latitude: 57.7219238 },
  { id: "synthetic-b", longitude: 11.9704142, latitude: 57.7219266 },
];
const identity = `osrm:local-synthetic:CH:car:${engine}:${datasetSha256}`;
const osrm = createDistrictOsrmProvider("http://127.0.0.1:5001", identity);
const controller = new AbortController();
const deadline = setTimeout(() => controller.abort(), 30_000);
try {
  const table = await osrm.table(points, points, controller.signal);
  assert.deepEqual(table.distances, [[0, 0.8], [0.8, 0]]);
  assert.equal(table.matrixRepairs?.length, 1);
  assert.equal(table.matrixRepairs[0].table.distance, -0.8);
  assert.equal(table.matrixRepairs[0].table.duration, 0);
  assert.deepEqual(table.matrixRepairs[0].replacement, { distance: 0.8, duration: 0 });
  const result = await solveDistrict({
    points: [...points, { ...points[0], id: "synthetic-colocated" }],
    start: { pointId: "synthetic-a" }, mode: "loop", serviceMinutes: 0,
  }, { onProgress: () => {}, isCancelled: () => false }, { provider: osrm, signal: controller.signal });
  assert.deepEqual(result.orderedPointIds.slice().sort(), ["synthetic-a", "synthetic-b", "synthetic-colocated"]);
  assert.equal(result.distanceMeters, 1.6);
  assert.equal(result.driveSeconds, 0);
  assert.equal(result.matrixRepairs?.[0].table.distance, -0.8);
  assert.equal(await fileHash(dataset), datasetSha256, "Dataset changed during acceptance.");
  const out = resolve(root, "generated-artifacts/district-negative-road");
  await mkdir(out, { recursive: true });
  const path = resolve(out, `${new Date().toISOString().replaceAll(":", "-")}.json`);
  await writeFile(path, JSON.stringify({
    fixture: "synthetic-public-road-pair", datasetSha256, engine, algorithm: "CH", profile: "car",
    attribution: "© OpenStreetMap contributors; ODbL 1.0",
    snapLimitMeters: 250, table, result,
  }, null, 2), { flag: "wx" });
  process.stdout.write(`Verified real CH table -0.8 m → car route 0.8 m; co-located IDs preserved. Evidence: ${path}\n`);
} finally {
  clearTimeout(deadline);
  controller.abort();
}
