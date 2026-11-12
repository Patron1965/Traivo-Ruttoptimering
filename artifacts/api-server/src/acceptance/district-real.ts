import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Server } from "node:http";
import { db, pool, organizationsTable, usersTable } from "@workspace/db";
import { createSession } from "../lib/session";
import { solveDistrict, type DistrictInput, type DistrictMeasurements, type DistrictResult } from "../services/district-solver";
import JSZip from "jszip";
import {
  acceptanceTables, acquireSchemaLock, releaseSchemaLock, verifyDevelopment, schemaMarker,
  type SqlConnection,
} from "./district-schema-policy";

type SourceRow = {
  objectNumber: string; sourceRowNumber: number; address: string;
  latitude: number; longitude: number; original: Record<string, string>;
  accepted: boolean; verifiedAt: string;
};
type Point = SourceRow & { id: string };
type Job = { id: string; status: string; progress: number; result?: DistrictResult; error?: string };

const directory = resolve("../../.cache/district-road");
const schema = `district_real_${randomUUID().replaceAll("-", "")}`;
let server: Server | undefined;
let worker: ChildProcess | undefined;
let schemaCreated = false;
let cacheLease: ChildProcess | undefined;
let cacheLeaseExited: Promise<unknown> | undefined;
let releasingCacheLease = false;
let schemaLease: (SqlConnection & { release(): void; on(event: "error", listener: (error: Error) => void): unknown }) | undefined;
let token = "", base = "", root = "", zoneId = "", zoneRevision = 0;
const evidence: Record<string, unknown> = {};

async function acquireCacheLease() {
  cacheLease = spawn("python", [resolve("../../scripts/district-cache-retention.py"), "--hold-lock"], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  cacheLease.stderr?.on("data", () => {});
  cacheLeaseExited = once(cacheLease, "exit");
  await new Promise<void>((success, failure) => {
    let output = "";
    cacheLease!.stdout!.on("data", chunk => {
      output += chunk.toString();
      if (output === "LOCKED\n") success();
    });
    cacheLease!.once("error", failure);
    cacheLease!.once("exit", () => failure(new Error("District cache is busy or retention failed; acceptance not started.")));
  });
  cacheLease.once("exit", () => {
    if (!releasingCacheLease) {
      // Continuing after an unexpectedly lost lease could race with retention.
      worker?.kill("SIGKILL");
      console.error("District cache lease was lost; acceptance stopped.");
      process.exit(1);
    }
  });
}

async function request(path: string, method = "GET", body?: unknown, status = 200): Promise<any> {
  const response = await fetch(base + path, {
    method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Connection: "close" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(30_000),
  });
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text);
}
async function listen() {
  const { default: app } = await import("../app");
  server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  base = `http://127.0.0.1:${address.port}`;
}
async function closeServer() {
  if (!server) return;
  const closing = once(server, "close");
  server.close();
  server.closeAllConnections();
  await closing;
  server = undefined;
}
function startWorker() {
  worker = spawn(process.execPath, ["--import", "tsx", "src/acceptance/district-real-worker.ts"], {
    env: { ...process.env, DISTRICT_ACCEPTANCE_SCHEMA: schema },
    // Keep the lease's write endpoint open in the worker too. If this harness
    // is killed, retention still waits for any surviving worker to finish.
    stdio: ["ignore", "ignore", "pipe", cacheLease!.stdin!],
  });
  // Errors deliberately exclude source data and configuration values.
  worker.stderr?.on("data", () => {});
  return once(worker, "exit");
}
async function waitForJob(id: string, predicate: (job: Job) => boolean, limit = 180_000) {
  const deadline = Date.now() + limit;
  while (Date.now() < deadline) {
    const response = await request(`${root}/jobs/${id}`);
    const job = { ...response.job, ...(response.result ? { result: response.result } : {}) } as Job;
    if (predicate(job)) return job;
    if (["failed", "stale"].includes(job.status)) throw new Error(job.error ?? job.status);
    await sleep(200);
  }
  throw new Error("Real district acceptance timed out.");
}
function validate(result: DistrictResult, points: Point[], mode: "loop" | "open") {
  assert.equal(result.orderedPointIds.length, 500);
  assert.deepEqual(new Set(result.orderedPointIds), new Set(points.map(p => p.id)));
  assert.equal(result.orderedPointIds[0], points[0].id);
  if (mode === "open") assert.equal(result.orderedPointIds.at(-1), points.at(-1)!.id);
  assert.ok(result.geometry.length > 500, "Actual road geometry must contain intermediate road vertices.");
  assert.ok(result.distanceMeters > 0 && result.driveSeconds > 0);
  const start = result.geometry[0], end = result.geometry.at(-1)!;
  if (mode === "loop") assert.ok(Math.abs(start.latitude - end.latitude) < 0.000025 && Math.abs(start.longitude - end.longitude) < 0.000025);
  assert.ok(Math.abs(start.latitude - points[0].latitude) < 0.003 && Math.abs(start.longitude - points[0].longitude) < 0.003);
  if (mode === "open") assert.ok(Math.abs(end.latitude - points.at(-1)!.latitude) < 0.003 && Math.abs(end.longitude - points.at(-1)!.longitude) < 0.003);
}
async function newJob(input: DistrictInput) {
  const job = await request(`${root}/zones/${zoneId}/jobs`, "POST", {
    expectedRevision: zoneRevision, mode: input.mode, start: input.start,
    ...(input.end ? { end: input.end } : {}), serviceMinutes: 0,
  }, 201) as Job;
  zoneRevision = (await request(root)).zones.find((z: { id: string }) => z.id === zoneId).revision;
  return job;
}
async function main() {
  assert.equal(process.env.NODE_ENV, "test");
  assert.notEqual(process.env.REPLIT_DEPLOYMENT, "1");
  assert.equal(process.env.OSRM_BASE_URL, "http://127.0.0.1:5001", "Use only the approved private development provider.");
  assert.ok(process.env.DEV_DB_FINGERPRINT, "An explicitly verified development database fingerprint is required.");
  process.env.RATE_LIMIT_MAX = "10000";
  await acquireCacheLease();
  const source = JSON.parse(await readFile(resolve(directory, "real-stenungsund-500.json"), "utf8"));
  const rows: SourceRow[] = source.rows;
  assert.equal(rows.length, 500);
  assert.ok(rows.every(r => r.accepted && Date.now() - Date.parse(r.verifiedAt) < 30 * 86400_000));
  assert.equal(new Set(rows.map(r => `${r.latitude},${r.longitude}`)).size, 500);
  schemaLease = await pool.connect();
  schemaLease.on("error", () => {
    worker?.kill("SIGKILL");
    console.error("District database lease was lost; acceptance stopped.");
    process.exit(1);
  });
  const fingerprint = await verifyDevelopment(schemaLease);
  await acquireSchemaLock(schemaLease);
  // Do not return this dedicated connection to the application pool.
  const outside={id:"out-of-coverage",latitude:59.33,longitude:18.06};
  const inside={id:"in-coverage",latitude:source.rows[0].latitude,longitude:source.rows[0].longitude};
  const coverageCallbacks={onProgress:()=>{},isCancelled:()=>false};
  for(const input of [
    {points:[outside],start:{pointId:outside.id},mode:"loop" as const,serviceMinutes:0},
    {points:[inside],start:{latitude:outside.latitude,longitude:outside.longitude},mode:"open" as const,serviceMinutes:0},
    {points:[inside],start:{pointId:inside.id},end:{latitude:outside.latitude,longitude:outside.longitude},mode:"open" as const,serviceMinutes:0},
  ]) await assert.rejects(solveDistrict(input,coverageCallbacks),/väganknytning inom 250 meter/);
  const colocated=await solveDistrict({
    points:[inside,{...inside,id:"co-located"}],start:{pointId:inside.id},mode:"loop",serviceMinutes:0,
  },coverageCallbacks);
  assert.deepEqual(colocated.orderedPointIds.slice().sort(),["co-located","in-coverage"]);
  assert.equal(colocated.distanceMeters,0);
  evidence.coverage={distantStopRejected:true,externalStartRejected:true,externalEndRejected:true,
    colocatedObjectsPreserved:true,oneCoordinateTableAccepted:true,maximumSnapMeters:250};
  // One connection is reserved for the lifetime lock, one for application work.
  pool.options.max = 2;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const expiresAt = new Date(Math.min(...rows.map(r => Date.parse(r.verifiedAt))) + 30 * 86400_000).toISOString();
    const comment = schemaMarker(fingerprint, expiresAt).replaceAll("'", "''");
    await client.query(`COMMENT ON SCHEMA "${schema}" IS '${comment}'`);
    for (const table of acceptanceTables)
      await client.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    pool.options.options = `-c search_path=${schema}`;
    await client.query(`SET search_path TO "${schema}"`);
  } finally { client.release(); }
  const organizationId = randomUUID(), userId = randomUUID();
  await db.insert(organizationsTable).values({ id: organizationId, name: "Isolated real-road acceptance", email: `${organizationId}@example.test` });
  await db.insert(usersTable).values({ id: userId, organizationId, role: "dispatcher", name: "Acceptance", email: `${userId}@example.test` });
  token = (await createSession({ userId, organizationId, userAgent: "district-real-acceptance" })).token;
  await listen();
  const plan = await request("/api/district-plans", "POST", { name: "Stenungsund 500 verifierade verkliga objekt" }, 201);
  root = `/api/district-plans/${plan.id}`;
  const imported = await request(`${root}/imports`, "POST", {
    sourceKey: `real:${source.sourceSha256}`,
    rows: rows.map(r => ({ ...r.original, Lat: String(r.latitude), Lon: String(r.longitude), OriginalSourceRow: String(r.sourceRowNumber) })),
    mapping: { objectNumber: "Objektid", address: "Fastighetsadress", latitude: "Lat", longitude: "Lon" },
    confirmValidOnly: false,
  }, 201);
  assert.equal(imported.total, 500); assert.equal(imported.valid, 500); assert.equal(imported.rejected, 0);
  const points: Point[] = (await request(`${root}/points`)).points;
  assert.equal(points.length, 500);
  for (let i = 0; i < 500; i++) {
    assert.equal(points[i].objectNumber, rows[i].objectNumber);
    for (const [key, value] of Object.entries(rows[i].original)) assert.equal(points[i].original[key], value);
  }
  const zone = await request(`${root}/zones`, "POST", { name: "Stenungsund verifierad provzon", color: "#3172d0", pointIds: points.map(p => p.id), transfers: [] }, 201);
  zoneId = zone.id;
  const loop: DistrictInput = { points, mode: "loop", start: { pointId: points[0].id }, serviceMinutes: 0 };
  const open: DistrictInput = { ...loop, mode: "open", end: { pointId: points.at(-1)!.id } };
  const measured: unknown[] = [];
  for (const [label, input] of [["cold-loop", loop], ["warm-provider-loop", loop], ["warm-loop", loop], ["warm-open", open]] as const) {
    let measurements: DistrictMeasurements | undefined;
    const result = await solveDistrict(input, { onProgress: () => {}, isCancelled: () => false }, {
      warmMatrixCache: label !== "warm-provider-loop", onMeasurements: value => { measurements = value; },
    });
    validate(result, points, input.mode);
    assert.ok(measurements);
    assert.equal(measurements.matrixCells, 250_000);
    assert.ok(measurements.asymmetricDistancePairs > 0, "Road matrix must not be silently symmetrized.");
    const cacheHit = label === "warm-loop" || label === "warm-open";
    assert.equal(measurements.matrixCacheHit, cacheHit);
    assert.equal(measurements.tableRequests, cacheHit ? 0 : 100);
    assert.ok(result.distanceMeters <= measurements.sourceOrderDistanceMeters + 1);
    const record = { label, ...measurements, distanceMeters: result.distanceMeters, driveSeconds: result.driveSeconds,
      geometryVertices: result.geometry.length, sourceOrderImprovementPercent: 100 * (1 - result.distanceMeters / measurements.sourceOrderDistanceMeters) };
    measured.push(record);
    console.log(JSON.stringify(record));
  }
  evidence.measurements = measured;
  // A real OS process is killed during a real matrix request, not a simulated
  // expired lease or fabricated result. The natural 60-second lease expires.
  const resumable = await newJob(loop);
  let exited = startWorker();
  await waitForJob(resumable.id, j => j.status === "running" && j.progress > 0 && j.progress < 70);
  worker!.kill("SIGKILL");
  await exited; worker = undefined;
  const [interrupted] = (await pool.query("SELECT attempts, lease_until, result FROM district_jobs WHERE id=$1", [resumable.id])).rows;
  assert.equal(interrupted.attempts, 1); assert.equal(interrupted.result, null);
  await closeServer();
  await listen();
  assert.equal((await request(root)).jobs.find((j: Job) => j.id === resumable.id).status, "running");
  const leaseWait = Math.max(0, new Date(interrupted.lease_until).getTime() - Date.now()) + 500;
  console.log("Process killed; waiting for natural lease expiry before reopening:", leaseWait);
  await sleep(leaseWait);
  exited = startWorker();
  const completed = await waitForJob(resumable.id, j => j.status === "completed");
  await exited; worker = undefined;
  validate(completed.result!, points, "loop");
  assert.equal((await pool.query("SELECT attempts FROM district_jobs WHERE id=$1", [resumable.id])).rows[0].attempts, 2);
  evidence.processRecovery = { killedDuringMatrix: true, naturalLeaseExpiry: true, attempts: 2, reopenedApi: true, preservedStops: 500 };
  // Actual historical snapshot and route-order download through authenticated API.
  const exported = await request(`${root}/jobs/${completed.id}/exports`, "POST", {
    pointIds: completed.result!.orderedPointIds, columns: ["Fastighetsadress", "Objektid", "OriginalSourceRow"], confirmReexport: false,
  }, 201);
  const exportId = exported.export.id;
  let csv = "";
  for (const format of ["csv", "xlsx"]) {
    const response = await fetch(`${base}${root}/exports/${exportId}/file?format=${format}`, { headers: { Authorization: `Bearer ${token}`, Connection: "close" } });
    assert.equal(response.status, 200);
    const buffer = Buffer.from(await response.arrayBuffer());
    await writeFile(resolve(directory, `stenungsund-500-loop.${format}`), buffer);
    if (format === "csv") {
      csv = buffer.toString("utf8");
      assert.equal(csv.trim().split("\r\n").length, 501);
      const csvRows = csv.trim().split("\r\n").slice(1);
      for (let i = 0; i < 500; i++) {
        const point = points.find(p => p.id === completed.result!.orderedPointIds[i])!;
        assert.ok(csvRows[i].includes(`"${point.objectNumber}"`));
        assert.ok(csvRows[i].includes(`"${point.address.replaceAll('"', '""')}"`));
      }
    } else {
      const zip = await JSZip.loadAsync(buffer);
      const sheet = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
      assert.equal((sheet.match(/<row\b/g) ?? []).length, 501);
    }
  }
  await writeFile(resolve(directory, "stenungsund-500-loop.geojson"), JSON.stringify({
    type: "FeatureCollection",
    features: [{ type: "Feature", properties: { source: "OpenStreetMap / Geofabrik, OSRM car CH", objects: 500 },
      geometry: { type: "LineString", coordinates: completed.result!.geometry.map(p => [p.longitude, p.latitude]) } }],
  }));
  const openJob = await newJob(open);
  exited = startWorker();
  const openDone = await waitForJob(openJob.id, j => j.status === "completed");
  await exited; worker = undefined;
  validate(openDone.result!, points, "open");
  // A different endpoint config invalidates new extraction from the old result,
  // while its existing immutable export remains byte-identical.
  const historical = await fetch(`${base}${root}/exports/${exportId}/file?format=csv`, { headers: { Authorization: `Bearer ${token}`, Connection: "close" } });
  assert.equal(Buffer.from(await historical.arrayBuffer()).toString("utf8"), csv);
  const cancel = await newJob(open);
  exited = startWorker();
  await waitForJob(cancel.id, j => j.status === "running" && j.progress > 0);
  await request(`${root}/jobs/${cancel.id}/cancel`, "POST", {});
  await exited; worker = undefined;
  const cancelled = (await request(`${root}/jobs/${cancel.id}`)).job as Job;
  assert.equal(cancelled.status, "cancelled"); assert.equal(cancelled.result, undefined);
  await closeServer(); await listen();
  assert.equal((await request(`${root}/jobs/${cancel.id}`)).job.status, "cancelled");
  evidence.cancellation = { realRunningJob: true, cancelledPersistedAfterReopen: true, noResult: true };
  evidence.export = { csvRows: 500, xlsxRows: 500, historicalByteIdentical: true, actualLoopGeometry: true };
  evidence.provenance = { sourceSha256: source.sourceSha256, sheet: source.sheet, realVerifiedAddresses: 500,
    uniqueCoordinates: 500, googleCalls: source.calls, maximumGeocodingCostUsdBeforeTax: source.calls * 0.005 };
  evidence.scope = "Approved private development OSRM and Stenungsund sample; not production readiness or nationwide coverage.";
  evidence.executedAt = new Date().toISOString();
  await mkdir(directory, { recursive: true });
  await writeFile(resolve(directory, "real-acceptance-summary.json"), JSON.stringify(evidence, null, 2));
  console.log("Real road acceptance passed; private evidence and exports saved.");
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Acceptance failed."); process.exitCode = 1; })
  .finally(async () => {
    if (worker && worker.exitCode === null) {
      const ended = once(worker, "exit"); worker.kill("SIGKILL"); await ended;
    }
    try {
      await closeServer();
      try {
        if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
      } finally {
        if (schemaLease) {
          await releaseSchemaLock(schemaLease);
          schemaLease.release();
          schemaLease = undefined;
        }
        await pool.end();
      }
    } finally {
      releasingCacheLease = true;
      cacheLease?.stdin?.end();
      if (cacheLeaseExited) {
        const [code] = await cacheLeaseExited as [number | null];
        if (code !== 0) {
          console.error("District retention lease failed.");
          process.exitCode = 1;
        }
      }
    }
  });