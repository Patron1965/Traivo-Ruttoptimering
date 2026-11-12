import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import {
  db,
  districtExportsTable,
  districtImportsTable,
  districtJobsTable,
  districtPlansTable,
  districtPointsTable,
  districtZonesTable,
  organizationsTable,
  organizationServicePoliciesTable,
  pool,
  usersTable,
} from "@workspace/db";
import { eq, inArray } from "drizzle-orm";
import JSZip from "jszip";
import { createSession } from "./lib/session";
import { tickDistrictWorker } from "./services/district-worker";
import { prohibitExternalTestConnections } from "./lib/tenant-test-network";

type Tenant = {
  organizationId: string;
  userId: string;
  token: string;
  viewerToken: string;
  driverToken: string;
  marker: string;
  planId: string;
  alternatePlanId: string;
  zoneId: string;
  pointIds: string[];
  latitude: number;
  longitude: number;
  completedJobId: string;
  cancelJobId: string;
  exportId: string;
};

const runId = randomUUID();
const schema = `district_tenant_${runId.replaceAll("-", "")}`;
const tenants: Tenant[] = [];
const originalOsrm = process.env.OSRM_BASE_URL;
const originalRateLimit = process.env.RATE_LIMIT_MAX;
let schemaCreated = false;
let server: Server | undefined;
let providerServer: Server | undefined;
let baseUrl = "";
let activeWorker: Promise<void> | undefined;
let releaseTable: (() => void) | undefined;
let observeTable: (() => void) | undefined;
let restoreNetwork: (() => void) | undefined;
const providerRequests: Array<{ kind: string; coordinates: number[][] }> = [];

async function request(tenant: Pick<Tenant, "token">, path: string, init: RequestInit = {}) {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${tenant.token}`);
  headers.set("Connection", "close");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl}${path}`, { ...init, headers, signal: AbortSignal.timeout(10_000) });
}

function mutation(method: string, body?: unknown): RequestInit {
  return { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}

async function json<T>(response: Response, status: number): Promise<T> {
  const text = await response.text();
  assert.equal(response.status, status, text);
  return JSON.parse(text) as T;
}

async function denied(response: Response, status: 403 | 404, forbidden: Tenant) {
  const text = await response.text();
  assert.equal(response.status, status, text);
  assert.equal(text.includes(forbidden.marker), false, text);
  // Result/order identifiers must not leak either, even without a text marker.
  for (const id of forbidden.pointIds) assert.equal(text.includes(id), false, text);
}

async function ownMarker(response: Response, owner: Tenant, foreign: Tenant) {
  const text = await response.text();
  assert.equal(response.status, 200, text);
  assert.equal(text.includes(owner.marker), true, text);
  assert.equal(text.includes(foreign.marker), false, text);
  return text;
}

const root = (tenant: Tenant) => `/api/district-plans/${tenant.planId}`;
const importBody = (marker: string, latitude = 57.7, longitude = 11.9) => ({
  sourceKey: `synthetic-source-${marker}`,
  mapping: { objectNumber: "Object", address: "Address", latitude: "Lat", longitude: "Lon" },
  rows: [0, 1].map((index) => ({
    Object: `${marker}-${index}`,
    Address: `${marker} address ${index}`,
    Lat: String(latitude + index / 1000),
    Lon: String(longitude + index / 1000),
    TenantMarker: marker,
  })),
  confirmValidOnly: true,
});
const zoneBody = (tenant: Tenant) => ({
  name: `${tenant.marker} zone`,
  color: "#abcdef",
  pointIds: tenant.pointIds,
  transfers: [],
});
const jobBody = (tenant: Tenant) => ({
  expectedRevision: 0,
  mode: "open",
  start: { pointId: tenant.pointIds[0] },
  serviceMinutes: 0,
});
const exportBody = (tenant: Tenant) => ({
  pointIds: tenant.pointIds,
  columns: ["TenantMarker", "Address"],
  confirmReexport: true,
});

async function persistedState(owners = tenants) {
  const orgIds = owners.map((tenant) => tenant.organizationId);
  const plans = await db.select().from(districtPlansTable)
    .where(inArray(districtPlansTable.organizationId, orgIds)).orderBy(districtPlansTable.id);
  const planIds = plans.map((plan) => plan.id);
  return {
    plans,
    imports: await db.select().from(districtImportsTable)
      .where(inArray(districtImportsTable.planId, planIds)).orderBy(districtImportsTable.id),
    points: await db.select().from(districtPointsTable)
      .where(inArray(districtPointsTable.planId, planIds)).orderBy(districtPointsTable.id),
    zones: await db.select().from(districtZonesTable)
      .where(inArray(districtZonesTable.planId, planIds)).orderBy(districtZonesTable.id),
    jobs: await db.select().from(districtJobsTable)
      .where(inArray(districtJobsTable.planId, planIds)).orderBy(districtJobsTable.id),
    exports: await db.select().from(districtExportsTable)
      .where(inArray(districtExportsTable.planId, planIds)).orderBy(districtExportsTable.id),
  };
}

async function listen(httpServer: Server) {
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const address = httpServer.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

async function close(httpServer: Server | undefined) {
  if (!httpServer?.listening) return;
  httpServer.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    httpServer.close((error) => error ? reject(error) : resolve()),
  );
}

before(async () => {
  assert.equal(process.env.NODE_ENV, "test", "District fixtures require NODE_ENV=test");
  restoreNetwork = prohibitExternalTestConnections();
  // This suite exercises tenant isolation and job quotas, not HTTP rate limits.
  // Keep the real middleware enabled with enough budget for its denial matrix.
  process.env.RATE_LIMIT_MAX = "1000";
  // A private schema also hides queued fixtures from the already-running worker.
  // Only this test process's pool is changed; there is NO public-table fallback.
  // All database writes, including asynchronous worker/audit writes, stay here.
  pool.options.max = 1;
  const client = await pool.connect();
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    schemaCreated = true;
    for (const table of [
      "organizations", "organization_routing_providers", "organization_service_policies", "users", "sessions", "audit_log",
      "district_plans", "district_imports", "district_zones", "district_points",
      "district_jobs", "district_exports",
    ]) {
      await client.query(`CREATE TABLE "${schema}"."${table}" (LIKE public."${table}" INCLUDING ALL)`);
    }
    // Future replacement connections must use the same isolated search_path.
    pool.options.options = `-c search_path=${schema}`;
    await client.query(`SET search_path TO "${schema}"`);
  } finally {
    client.release();
  }
  const searchPath = await pool.query("SHOW search_path");
  assert.equal(searchPath.rows[0].search_path, schema);

  // Explicitly SYNTHETIC OSRM wire responses. These test ownership, not real
  // roads, 500-stop capacity, route quality, provider approval or live timing.
  providerServer = createServer(async (req, res) => {
    try {
      const url = new URL(req.url ?? "/", "http://synthetic.invalid");
      const kind = url.pathname.split("/")[1];
      const coordinates = decodeURIComponent(url.pathname.split("/").at(-1) ?? "")
        .split(";").map((pair) => pair.split(",").map(Number));
      providerRequests.push({ kind, coordinates });
      if (kind === "table" && observeTable) {
        const observed = observeTable;
        observeTable = undefined;
        await new Promise<void>((resolve) => {
          releaseTable = resolve;
          observed();
        });
      }
      res.setHeader("Content-Type", "application/json");
      if (kind === "table") {
        const sources = (url.searchParams.get("sources") ?? "").split(";").map(Number);
        const destinations = (url.searchParams.get("destinations") ?? "").split(";").map(Number);
        const matrix = (cost: number) => sources.map((source) =>
          destinations.map((destination) => source === destination ? 0 : cost),
        );
        res.end(JSON.stringify({ code: "Ok", distances: matrix(100), durations: matrix(50),
          sources:sources.map(index=>({location:coordinates[index]})),
          destinations:destinations.map(index=>({location:coordinates[index]})),
        }));
      } else if (kind === "route") {
        res.end(JSON.stringify({
          code: "Ok",
          routes: [{ geometry: { type: "LineString", coordinates } }],
          waypoints: coordinates.map((location) => ({ location })),
        }));
      } else {
        res.statusCode = 404;
        res.end(JSON.stringify({ code: "InvalidUrl" }));
      }
    } catch (error) {
      res.statusCode = 500;
      res.end(JSON.stringify({ error: String(error) }));
    }
  });
  process.env.OSRM_BASE_URL = await listen(providerServer);

  const { default: app } = await import("./app");
  server = createServer(app);
  baseUrl = await listen(server);
  for (const label of ["A", "B"]) {
    const organizationId = randomUUID();
    const marker = `DISTRICT_TENANT_${label}_${runId}`;
    const userId = randomUUID();
    const viewerId = randomUUID();
    const driverId = randomUUID();
    // No integration, webhook, notification recipient, phone or push token.
    await db.insert(organizationsTable).values({
      id: organizationId, name: marker, email: `${organizationId}@example.test`,
    });
    await db.insert(organizationServicePoliciesTable).values({
      organizationId,
      policy: {
        districtEnabled: true, roadProvider: "osrm", geocodingProvider: "disabled",
        smsProvider: "disabled", emailEnabled: false, aiEnabled: false, cuoptEnabled: false,
      },
    });
    await db.insert(usersTable).values([
      { id: userId, organizationId, name: marker, email: `${userId}@example.test`, role: "dispatcher" },
      { id: viewerId, organizationId, name: marker, email: `${viewerId}@example.test`, role: "viewer" },
      { id: driverId, organizationId, name: marker, email: `${driverId}@example.test`, role: "driver" },
    ]);
    const session = async (id: string) => (await createSession({
      userId: id, organizationId, userAgent: "district-tenant-isolation-request-test",
    })).token;
    const tenant: Tenant = {
      organizationId, userId, marker, token: await session(userId),
      viewerToken: await session(viewerId), driverToken: await session(driverId),
      planId: "", alternatePlanId: "", zoneId: "", pointIds: [],
      latitude: label === "A" ? 57.7 : 58.7, longitude: label === "A" ? 11.9 : 12.9,
      completedJobId: randomUUID(), cancelJobId: randomUUID(), exportId: "",
    };
    tenants.push(tenant);
    for (const key of ["planId", "alternatePlanId"] as const) {
      const plan = await json<{ id: string }>(await request(tenant, "/api/district-plans",
        mutation("POST", { name: `${marker} ${key}`, organizationId })), 201);
      tenant[key] = plan.id;
    }
    const source = {
      ...importBody(marker, tenant.latitude, tenant.longitude),
      organizationId, planId: tenant.planId,
    };
    const preview = await json<{ valid: number }>(await request(tenant,
      `${root(tenant)}/imports/preview`, mutation("POST", source)), 200);
    assert.equal(preview.valid, 2);
    await json(await request(tenant, `${root(tenant)}/imports`, mutation("POST", source)), 201);
    const points = await json<{ points: Array<{ id: string; original: { TenantMarker: string } }> }>(
      await request(tenant, `${root(tenant)}/points`), 200,
    );
    assert.deepEqual(points.points.map((point) => point.original.TenantMarker), [marker, marker]);
    tenant.pointIds = points.points.map((point) => point.id);
    const zone = await json<{ id: string }>(await request(tenant,
      `${root(tenant)}/zones`, mutation("POST", zoneBody(tenant))), 201);
    tenant.zoneId = zone.id;

    // Persisted job/result fixtures are intentionally synthetic authorization
    // evidence, NOT results from a real provider or performance acceptance.
    const input = {
      points: tenant.pointIds.map((id, index) => ({
        id, latitude: tenant.latitude + index / 1000, longitude: tenant.longitude + index / 1000,
      })),
      mode: "open" as const, start: { pointId: tenant.pointIds[0] }, serviceMinutes: 0,
    };
    await db.insert(districtJobsTable).values([
      {
        id: tenant.completedJobId, planId: tenant.planId, zoneId: tenant.zoneId,
        revision: 0, status: "completed", progress: 100, input,
        result: {
          orderedPointIds: tenant.pointIds, distanceMeters: 100, driveSeconds: 50,
          geometry: [{ latitude: tenant.latitude, longitude: tenant.longitude }],
          warnings: [`SYNTHETIC fixture ${marker}`],
        },
      },
      {
        id: tenant.cancelJobId, planId: tenant.planId, zoneId: tenant.zoneId,
        revision: 0, status: "queued", input,
      },
    ]);
    const exported = await json<{ export: { id: string; actorId: string } }>(await request(tenant,
      `${root(tenant)}/jobs/${tenant.completedJobId}/exports`, mutation("POST", exportBody(tenant))), 201);
    assert.equal(exported.export.actorId, userId);
    tenant.exportId = exported.export.id;
  }
});

after(async () => {
  releaseTable?.();
  const errors: unknown[] = [];
  const cleanup = async (operation: () => Promise<unknown>) => {
    try { await operation(); } catch (error) { errors.push(error); }
  };
  if (activeWorker) await cleanup(() => activeWorker!);
  await cleanup(() => close(server));
  await cleanup(() => close(providerServer));
  if (originalOsrm === undefined) delete process.env.OSRM_BASE_URL;
  else process.env.OSRM_BASE_URL = originalOsrm;
  if (originalRateLimit === undefined) delete process.env.RATE_LIMIT_MAX;
  else process.env.RATE_LIMIT_MAX = originalRateLimit;
  if (schemaCreated) {
    // Drain finish-hook audit inserts before removing all disposable tenants.
    await cleanup(() => pool.query("SELECT 1"));
    await cleanup(() => pool.query(`DROP SCHEMA "${schema}" CASCADE`));
    await cleanup(async () => {
      const remaining = await pool.query("SELECT 1 FROM pg_namespace WHERE nspname = $1", [schema]);
      assert.equal(remaining.rowCount, 0, "Disposable district schema was not removed");
    });
  }
  await cleanup(() => pool.end());
  await cleanup(async () => restoreNetwork?.());
  if (errors.length) throw new AggregateError(errors, "District tenant fixture cleanup failed");
});

test("real sessions read their own district markers, job results and CSV/XLSX snapshots only", async () => {
  for (const [owner, foreign] of [[tenants[0], tenants[1]], [tenants[1], tenants[0]]]) {
    for (const path of [
      "/api/district-plans", root(owner), `${root(owner)}/points`,
      `${root(owner)}/jobs/${owner.completedJobId}`,
      `${root(owner)}/exports/${owner.exportId}/file?format=csv`,
    ]) await ownMarker(await request(owner, path), owner, foreign);
    const results = await json<{ result: { orderedPointIds: string[] } }>(
      await request(owner, `${root(owner)}/jobs/${owner.completedJobId}`), 200,
    );
    assert.deepEqual(results.result.orderedPointIds, owner.pointIds);
    const history = await json<{ exports: Array<{ id: string; actorId: string; pointIds: string[] }> }>(
      await request(owner, `${root(owner)}/exports`), 200,
    );
    assert.deepEqual(history.exports.map((entry) => entry.id), [owner.exportId]);
    assert.equal(history.exports[0].actorId, owner.userId);
    assert.deepEqual(history.exports[0].pointIds, owner.pointIds);
    const workbook = await request(owner, `${root(owner)}/exports/${owner.exportId}/file?format=xlsx`);
    assert.equal(workbook.status, 200);
    assert.match(workbook.headers.get("cache-control") ?? "", /private.*no-store/);
    const zip = await JSZip.loadAsync(await workbook.arrayBuffer());
    const xml = (await Promise.all(Object.values(zip.files).filter((file) =>
      !file.dir && file.name.endsWith(".xml")).map((file) => file.async("string")))).join("\n");
    assert.equal(xml.includes(owner.marker), true);
    assert.equal(xml.includes(foreign.marker), false);
  }
  assert.equal(providerRequests.length, 0, "Fixture reads/exports must not call a road provider");
});

test("foreign plans deny every district read/write with no persisted mutation or result leakage", async () => {
  const beforeState = await persistedState();
  for (const [actor, foreign] of [[tenants[0], tenants[1]], [tenants[1], tenants[0]]]) {
    const foreignRoot = root(foreign);
    const attempts: Array<[string, RequestInit?]> = [
      [foreignRoot],
      [`${foreignRoot}/points`],
      [`${foreignRoot}/exports`],
      [`${foreignRoot}/jobs/${foreign.completedJobId}`],
      [`${foreignRoot}/jobs/${foreign.cancelJobId}`],
      [`${foreignRoot}/exports/${foreign.exportId}/file?format=csv`],
      [`${foreignRoot}/exports/${foreign.exportId}/file?format=xlsx`],
      [`${foreignRoot}/imports/preview`, mutation("POST", importBody(actor.marker))],
      [`${foreignRoot}/imports`, mutation("POST", importBody(actor.marker))],
      [`${foreignRoot}/zones`, mutation("POST", zoneBody(foreign))],
      [`${foreignRoot}/zones/${foreign.zoneId}`, mutation("PUT", { ...zoneBody(foreign), expectedRevision: 0 })],
      [`${foreignRoot}/zones/${foreign.zoneId}`, mutation("DELETE", { expectedRevision: 0, confirm: true })],
      [`${foreignRoot}/zones/${foreign.zoneId}/jobs`, mutation("POST", jobBody(foreign))],
      [`${foreignRoot}/jobs/${foreign.cancelJobId}/cancel`, mutation("POST")],
      [`${foreignRoot}/jobs/${foreign.completedJobId}/exports`, mutation("POST", exportBody(foreign))],
    ];
    for (const [path, init] of attempts) await denied(await request(actor, path, init), 404, foreign);
  }
  assert.deepEqual(await persistedState(), beforeState);
});

test("foreign or wrong-plan zone/job/export IDs beneath an owned plan cannot bypass nested ownership", async () => {
  const beforeState = await persistedState();
  for (const [actor, foreign] of [[tenants[0], tenants[1]], [tenants[1], tenants[0]]]) {
    // Both cross-tenant IDs under the actor's plan and valid own IDs under a
    // different owned plan must fail; ownership alone is not plan agreement.
    for (const [planRoot, resource] of [
      [root(actor), foreign],
      [`/api/district-plans/${actor.alternatePlanId}`, actor],
    ] as const) {
      for (const [path, init] of [
        [`${planRoot}/zones/${resource.zoneId}`, mutation("PUT", { ...zoneBody(actor), expectedRevision: 0 })],
        [`${planRoot}/zones/${resource.zoneId}`, mutation("DELETE", { expectedRevision: 0, confirm: true })],
        [`${planRoot}/zones/${resource.zoneId}/jobs`, mutation("POST", jobBody(actor))],
        [`${planRoot}/jobs/${resource.completedJobId}`, undefined],
        [`${planRoot}/jobs/${resource.cancelJobId}/cancel`, mutation("POST")],
        [`${planRoot}/jobs/${resource.completedJobId}/exports`, mutation("POST", exportBody(actor))],
        [`${planRoot}/exports/${resource.exportId}/file?format=csv`, undefined],
        [`${planRoot}/exports/${resource.exportId}/file?format=xlsx`, undefined],
      ] as Array<[string, RequestInit | undefined]>) {
        await denied(await request(actor, path, init), 404, resource);
      }
    }
  }
  assert.deepEqual(await persistedState(), beforeState);
});

test("forged organization query/body hints fail closed; headers cannot retarget a real session", async () => {
  const beforeState = await persistedState();
  for (const [actor, foreign] of [[tenants[0], tenants[1]], [tenants[1], tenants[0]]]) {
    for (const path of [
      "/api/district-plans", root(actor), `${root(actor)}/points`, `${root(actor)}/exports`,
      `${root(actor)}/jobs/${actor.completedJobId}`,
      `${root(actor)}/exports/${actor.exportId}/file?format=csv`,
    ]) {
      const separator = path.includes("?") ? "&" : "?";
      await denied(await request(actor, `${path}${separator}organizationId=${foreign.organizationId}`), 403, foreign);
    }
    for (const [path, body] of [
      ["/api/district-plans", { name: `${actor.marker} forged` }],
      [`${root(actor)}/imports/preview`, importBody(actor.marker)],
      [`${root(actor)}/imports`, importBody(actor.marker)],
      [`${root(actor)}/zones`, zoneBody(actor)],
      [`${root(actor)}/zones/${actor.zoneId}/jobs`, jobBody(actor)],
      [`${root(actor)}/jobs/${actor.cancelJobId}/cancel`, {}],
      [`${root(actor)}/jobs/${actor.completedJobId}/exports`, exportBody(actor)],
    ] as const) {
      await denied(await request(actor, path, mutation("POST",
        { ...body, organizationId: foreign.organizationId })), 403, foreign);
    }
    for (const [method, body] of [
      ["PUT", { ...zoneBody(actor), expectedRevision: 0 }],
      ["DELETE", { expectedRevision: 0, confirm: true }],
    ] as const) {
      await denied(await request(actor, `${root(actor)}/zones/${actor.zoneId}`,
        mutation(method, { ...body, organizationId: foreign.organizationId })), 403, foreign);
    }
    // A matching body cannot launder a conflicting query scope.
    await denied(await request(actor,
      `${root(actor)}/jobs/${actor.cancelJobId}/cancel?organizationId=${foreign.organizationId}`,
      mutation("POST", { organizationId: actor.organizationId })), 403, foreign);
    const forgedHeaders = {
      "X-Organization-ID": foreign.organizationId, "X-Org": foreign.organizationId,
      "X-User-ID": foreign.userId, "X-Role": "admin",
    };
    await ownMarker(await request(actor, "/api/district-plans", { headers: forgedHeaders }), actor, foreign);
    await denied(await request(actor, root(foreign), { headers: forgedHeaders }), 404, foreign);
  }
  assert.deepEqual(await persistedState(), beforeState);
});

test("body/route plan mismatches are denied before imports, zone changes, jobs, cancel or exports", async () => {
  const beforeState = await persistedState();
  for (const [actor, foreign] of [[tenants[0], tenants[1]], [tenants[1], tenants[0]]]) {
    for (const suppliedPlanId of [foreign.planId, actor.alternatePlanId]) {
      for (const [path, method, body] of [
        [`${root(actor)}/imports/preview`, "POST", importBody(actor.marker)],
        [`${root(actor)}/imports`, "POST", importBody(actor.marker)],
        [`${root(actor)}/zones`, "POST", zoneBody(actor)],
        [`${root(actor)}/zones/${actor.zoneId}`, "PUT", { ...zoneBody(actor), expectedRevision: 0 }],
        [`${root(actor)}/zones/${actor.zoneId}`, "DELETE", { expectedRevision: 0, confirm: true }],
        [`${root(actor)}/zones/${actor.zoneId}/jobs`, "POST", jobBody(actor)],
        [`${root(actor)}/jobs/${actor.cancelJobId}/cancel`, "POST", {}],
        [`${root(actor)}/jobs/${actor.completedJobId}/exports`, "POST", exportBody(actor)],
      ] as const) {
        await denied(await request(actor, path,
          mutation(method, { ...body, planId: suppliedPlanId })), 404, foreign);
      }
    }
  }
  assert.deepEqual(await persistedState(), beforeState);
});

test("unauthenticated and role-restricted sessions cannot expose originals, mutate or download", async () => {
  const beforeState = await persistedState();
  for (const [actor, foreign] of [[tenants[0], tenants[1]], [tenants[1], tenants[0]]]) {
    for (const token of ["", randomUUID()]) {
      const response = await request({ token }, root(actor));
      const text = await response.text();
      assert.equal(response.status, 401, text);
      assert.equal(text.includes(actor.marker), false);
    }
    const viewer = { token: actor.viewerToken };
    const points = await json<{ points: Array<{ original: object; address: string }> }>(
      await request(viewer, `${root(actor)}/points`), 200,
    );
    assert.equal(points.points[0].address.includes(actor.marker), true);
    assert.deepEqual(points.points.map((point) => point.original), [{}, {}]);
    await denied(await request(viewer, `${root(actor)}/zones`, mutation("POST", zoneBody(actor))), 403, foreign);
    await denied(await request(viewer,
      `${root(actor)}/exports/${actor.exportId}/file?format=csv`), 403, actor);
    await denied(await request({ token: actor.driverToken }, root(actor)), 403, actor);
    await denied(await request({ token: actor.driverToken },
      `${root(actor)}/jobs/${actor.cancelJobId}/cancel`, mutation("POST")), 403, actor);
  }
  assert.deepEqual(await persistedState(), beforeState);
});

test("each organization can cancel its own job and create/update/delete its own zone without changing the other", async () => {
  for (const [actor, foreign] of [[tenants[0], tenants[1]], [tenants[1], tenants[0]]]) {
    const foreignBefore = await persistedState([foreign]);
    const cancelled = await json<{ job: { id: string; status: string } }>(await request(actor,
      `${root(actor)}/jobs/${actor.cancelJobId}/cancel`, mutation("POST", { planId: actor.planId })), 200);
    assert.equal(cancelled.job.id, actor.cancelJobId);
    assert.equal(cancelled.job.status, "cancelled");
    const created = await json<{ id: string; revision: number }>(await request(actor,
      `${root(actor)}/zones`, mutation("POST", {
        name: `${actor.marker} mutable`, color: "#123456", pointIds: [],
        organizationId: actor.organizationId, planId: actor.planId,
      })), 201);
    const updated = await json<{ name: string; revision: number }>(await request(actor,
      `${root(actor)}/zones/${created.id}`, mutation("PUT", {
        name: `${actor.marker} updated`, color: "#654321", pointIds: [],
        expectedRevision: created.revision, planId: actor.planId,
      })), 200);
    assert.equal(updated.name, `${actor.marker} updated`);
    const deleted = await request(actor, `${root(actor)}/zones/${created.id}`, mutation("DELETE", {
      expectedRevision: updated.revision, confirm: true, planId: actor.planId,
    }));
    assert.equal(deleted.status, 204);
    const [persisted] = await db.select().from(districtZonesTable).where(eq(districtZonesTable.id, created.id));
    assert.ok(persisted.deletedAt);
    assert.deepEqual(await persistedState([foreign]), foreignBefore);
  }
});

test("actual asynchronous worker results stay with the queuing session tenant (synthetic local provider)", async () => {
  for (const [actor, foreign] of [[tenants[0], tenants[1]], [tenants[1], tenants[0]]]) {
    const foreignBefore = await persistedState([foreign]);
    const job = await json<{ id: string; status: string }>(await request(actor,
      `${root(actor)}/zones/${actor.zoneId}/jobs`, mutation("POST", jobBody(actor))), 201);
    assert.equal(job.status, "queued");
    const observed = new Promise<void>((resolve) => { observeTable = resolve; });
    const requestOffset = providerRequests.length;
    let observationTimeout: ReturnType<typeof setTimeout> | undefined;
    activeWorker = tickDistrictWorker();
    try {
      await Promise.race([
        observed,
        activeWorker.then(() => { throw new Error("Worker finished before the synthetic table request"); }),
        new Promise<never>((_resolve, reject) => {
          observationTimeout = setTimeout(() => reject(new Error("Worker table request timed out")), 5_000);
          observationTimeout.unref();
        }),
      ]);
      const running = await json<{ job: { status: string; zoneId: string } }>(
        await request(actor, `${root(actor)}/jobs/${job.id}`), 200,
      );
      assert.equal(running.job.status, "running");
      assert.equal(running.job.zoneId, actor.zoneId);
      // Foreign reads, route retargeting and cancellation fail DURING execution.
      await denied(await request(foreign, `${root(actor)}/jobs/${job.id}`), 404, actor);
      await denied(await request(foreign, `${root(foreign)}/jobs/${job.id}`), 404, actor);
      await denied(await request(foreign,
        `${root(actor)}/jobs/${job.id}/cancel`, mutation("POST")), 404, actor);
      await denied(await request(foreign,
        `${root(foreign)}/jobs/${job.id}/cancel`, mutation("POST")), 404, actor);
    } finally {
      clearTimeout(observationTimeout);
      observeTable = undefined;
      releaseTable?.();
      releaseTable = undefined;
      await activeWorker;
      activeWorker = undefined;
    }
    const result = await json<{
      job: { status: string; progress: number };
      result: { orderedPointIds: string[]; geometry: unknown[] };
    }>(await request(actor, `${root(actor)}/jobs/${job.id}`), 200);
    assert.equal(result.job.status, "completed");
    assert.equal(result.job.progress, 100);
    assert.deepEqual(new Set(result.result.orderedPointIds), new Set(actor.pointIds));
    assert.ok(result.result.geometry.length);
    const calls = providerRequests.slice(requestOffset);
    assert.equal(calls.some((call) => call.kind === "table"), true);
    assert.equal(calls.some((call) => call.kind === "route"), true);
    const ownCoordinates = new Set(actor.pointIds.map((_id, index) =>
      `${actor.longitude + index / 1000},${actor.latitude + index / 1000}`));
    for (const call of calls) {
      assert.equal(call.coordinates.every((coordinate) => ownCoordinates.has(coordinate.join(","))), true,
        "The asynchronous provider request contained coordinates outside the queuing tenant");
    }
    await denied(await request(foreign, `${root(actor)}/jobs/${job.id}`), 404, actor);
    await denied(await request(foreign, `${root(foreign)}/jobs/${job.id}`), 404, actor);
    const exported = await json<{ export: { id: string; actorId: string } }>(await request(actor,
      `${root(actor)}/jobs/${job.id}/exports`, mutation("POST", exportBody(actor))), 201);
    assert.equal(exported.export.actorId, actor.userId);
    await ownMarker(await request(actor,
      `${root(actor)}/exports/${exported.export.id}/file?format=csv`), actor, foreign);
    await denied(await request(foreign,
      `${root(actor)}/exports/${exported.export.id}/file?format=csv`), 404, actor);
    await denied(await request(foreign, `${root(actor)}/jobs/${job.id}/exports`,
      mutation("POST", exportBody(actor))), 404, actor);
    assert.deepEqual(await persistedState([foreign]), foreignBefore);
  }
});