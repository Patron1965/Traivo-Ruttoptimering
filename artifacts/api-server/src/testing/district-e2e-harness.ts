// Only launched by the saved Playwright fixture. No startup seeds, notifications,
// retention jobs or production provider configuration are run.
import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { db, pool, usersTable, districtPlansTable, districtZonesTable,
  districtImportsTable, districtPointsTable, districtIntakesTable,
  organizationServicePoliciesTable } from "@workspace/db";
import { eq } from "drizzle-orm";

if (process.env.NODE_ENV !== "test") throw new Error("District E2E requires NODE_ENV=test");
if (process.env.REPLIT_DEPLOYMENT === "1") throw new Error("District E2E must not run in a published runtime");
const schema = `district_e2e_${randomUUID().replaceAll("-", "")}`;
const controlKey = randomUUID();
const dataset = "synthetic-e2e-road-v1";
const rowCount = 801; // Exceeds the ordinary 750-point engine limit.
let release: (() => void) | undefined;
let gate: Promise<void> | undefined;
let providerCalls = 0;
let blockedExternalCalls = 0;
let worker: Promise<void> | undefined;
let timer: ReturnType<typeof setInterval> | undefined;
let shuttingDown = false;
let schemaCreated = false;
const provider = createServer(async (req, res) => {
  try {
    const url = new URL(req.url!, "http://local");
    const match = url.pathname.match(/^\/(table|route)\/v1\/driving\/(.+)$/);
    if (!match) { res.writeHead(404).end(); return; }
    providerCalls++;
    if (match[1] === "table" && gate) await gate;
    const coordinates = match[2].split(";").map(pair => pair.split(",").map(Number));
    const waypoint = (i: number) => ({ location: coordinates[i], distance: 0 });
    let body: unknown;
    if (match[1] === "table") {
      const sources = (url.searchParams.get("sources") ?? "").split(";").map(Number);
      const destinations = (url.searchParams.get("destinations") ?? "").split(";").map(Number);
      const costs = sources.map(a => destinations.map(b =>
        Math.abs(coordinates[a][0] - coordinates[b][0]) * 100000 +
        Math.abs(coordinates[a][1] - coordinates[b][1]) * 100000));
      body = { code: "Ok", distances: costs, durations: costs.map(r => r.map(d => d / 10)),
        sources: sources.map(waypoint), destinations: destinations.map(waypoint) };
    } else {
      const distance = coordinates.slice(1).reduce((sum, p, i) => sum +
        Math.abs(p[0] - coordinates[i][0]) * 100000 +
        Math.abs(p[1] - coordinates[i][1]) * 100000, 0);
      body = { code: "Ok", routes: [{ distance, duration: distance / 10,
        geometry: { type: "LineString", coordinates },
        legs: coordinates.slice(1).map(() => ({ distance, duration: distance / 10 })) }],
        waypoints: coordinates.map((_, i) => waypoint(i)) };
    }
    res.setHeader("x-osrm-dataset-id", dataset);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify(body));
  } catch (error) { res.writeHead(500).end(String(error)); }
});
let apiServer: ReturnType<typeof createServer> | undefined;

async function shutdown() {
  if (shuttingDown) return;
  shuttingDown = true;
  if (timer) clearInterval(timer);
  release?.();
  await worker;
  if (apiServer) await new Promise<void>(resolve => apiServer!.close(() => resolve()));
  if (provider.listening) await new Promise<void>(resolve => provider.close(() => resolve()));
  // Generated in this process, never accepted from an environment variable or
  // matched by prefix. No public tables or other test schemas are deleted.
  if (schemaCreated) await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
  await pool.end();
}

async function main() {
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    const tables = await client.query<{ tablename: string }>(
      "SELECT tablename FROM pg_tables WHERE schemaname = 'public'");
    for (const { tablename } of tables.rows) {
      const quoted = tablename.replaceAll('"', '""');
      await client.query(`CREATE TABLE "${schema}"."${quoted}" (LIKE public."${quoted}" INCLUDING ALL)`);
    }
    // No public fallback: a missing table must fail, not reach customer data.
    pool.options.options = `-c search_path=${schema}`;
    await client.query(`SET search_path TO "${schema}"`);
  } finally { client.release(); }

  // Test-only helper lives outside the deployable API's TypeScript root.
  const fixtureModule = "../../../../e2e/planning-draft-fixture";
  const { provisionDisposableAuthFixture } = await import(fixtureModule);
  const admin = await provisionDisposableAuthFixture(randomUUID(), { databaseSchema: schema });
  // Explicit opt-in only for this synthetic tenant in the owned schema.
  // Keep unrelated paid/outbound services disabled.
  await db.insert(organizationServicePoliciesTable).values({
    organizationId: admin.organizationId,
    policy: {
      districtEnabled: true, roadProvider: "osrm", geocodingProvider: "disabled",
      smsProvider: "disabled", emailEnabled: false, aiEnabled: false, cuoptEnabled: false,
    },
  });
  const [owner] = await db.select().from(usersTable).where(eq(usersTable.id, admin.userId));
  const viewer = { email: `district-viewer-${randomUUID()}@example.test`, password: admin.password };
  await db.insert(usersTable).values({ id: randomUUID(), organizationId: admin.organizationId,
    name: "Synthetic district viewer", email: viewer.email, passwordHash: owner.passwordHash, role: "viewer" });
  const [plan] = await db.insert(districtPlansTable).values({
    organizationId: admin.organizationId, name: "Syntetiskt stort distriktsunderlag" }).returning();
  const [zone] = await db.insert(districtZonesTable).values({
    planId: plan.id, name: "Syntetisk zon", color: "#112233" }).returning();
  const [imported] = await db.insert(districtImportsTable).values({ planId: plan.id,
    sourceKey: "synthetic", payloadHash: "synthetic", total: rowCount, valid: rowCount - 1,
    rejected: 1, revision: 0 }).returning();
  const originals = Array.from({ length: rowCount }, (_, i) => ({
    Object: String(i + 1).padStart(6, "0"),
    Address: i === rowCount - 1 ? "Olöst syntetisk adress" : `Syntetisk adress ${i + 1}`,
    CustomerOnly: `Värde ${i + 1}; "åäö"\nandra raden`,
    ...(i === rowCount - 1 ? { OnlyUnresolved: "Bevara även denna kolumn" } : {}),
  }));
  const points = await db.insert(districtPointsTable).values(originals.slice(0, -1).map((original, i) => ({
    planId: plan.id, importId: imported.id, zoneId: i % 5 === 0 ? null : zone.id,
    sourceRowNumber: i + 1, objectNumber: original.Object, address: original.Address,
    latitude: 57.708 + Math.floor((i === 1 ? 0 : i) / 40) * 0.0001,
    longitude: 11.974 + (i === 1 ? 0 : i) % 40 * 0.0001, original,
  }))).returning();
  await db.insert(districtIntakesTable).values({ planId: plan.id, sourceKey: "synthetic",
    payloadHash: "synthetic", rows: [
      ...points.map(p => ({ sourceRowNumber: p.sourceRowNumber, pointId: p.id,
        objectNumber: p.objectNumber, address: p.address, latitude: p.latitude, longitude: p.longitude,
        original: p.original, status: "ready" as const, reason: "" })),
      { sourceRowNumber: rowCount, objectNumber: originals.at(-1)!.Object,
        address: originals.at(-1)!.Address, original: originals.at(-1)!,
        status: "unresolved", reason: "Position saknas" },
    ] });

  provider.listen(0, "127.0.0.1");
  await once(provider, "listening");
  const providerOrigin = `http://127.0.0.1:${(provider.address() as AddressInfo).port}`;
  process.env.OSRM_BASE_URL = providerOrigin;
  process.env.DISTRICT_BULK_PROVIDERS_JSON = JSON.stringify([
    { serverId: "shared", datasetIdentity: dataset, maxTableCoordinates: 500 }]);
  // Fail before network access if any backend path tries geocoding/paid services.
  const nativeFetch = globalThis.fetch;
  globalThis.fetch = (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.origin !== providerOrigin) {
      blockedExternalCalls++;
      throw new Error("External network is forbidden in district E2E");
    }
    return nativeFetch(input, init);
  };
  const { default: app } = await import("../app");
  const { tickDistrictWorker } = await import("../services/district-worker");
  // Control routes are local-only and use an unguessable per-process key.
  app.post(`/__e2e/${controlKey}/hold`, (_req, res) => {
    gate = new Promise(resolve => { release = resolve; });
    res.json({ ok: true });
  });
  app.post(`/__e2e/${controlKey}/release`, async (_req, res) => {
    release?.(); gate = undefined;
    await worker;
    res.json({ ok: true });
  });
  app.get(`/__e2e/${controlKey}/evidence`, (_req, res) => {
    res.json({ providerCalls, blockedExternalCalls });
  });
  apiServer = createServer(app).listen(0, "127.0.0.1");
  await once(apiServer, "listening");
  timer = setInterval(() => {
    if (!worker) worker = tickDistrictWorker().finally(() => { worker = undefined; });
  }, 100);
  console.log("DISTRICT_E2E_READY " + JSON.stringify({
    origin: `http://127.0.0.1:${(apiServer.address() as AddressInfo).port}`,
    controlKey, admin, viewer, planId: plan.id, zoneId: zone.id, originals,
    pointIds: points.map(p => p.id), dataset,
  }));
}
process.once("SIGTERM", () => { void shutdown().then(() => process.exit(0)); });
process.once("SIGINT", () => { void shutdown().then(() => process.exit(0)); });
main().catch(async error => {
  console.error(error);
  await shutdown();
  process.exitCode = 1;
});
