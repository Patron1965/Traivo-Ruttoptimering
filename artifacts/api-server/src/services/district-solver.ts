import { createHash } from "node:crypto";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";
import { selectDistrictProviderEnvironment } from "./district-provider-environment";
import { MAX_DISTRICT_MATRIX_REPAIRS, verifiedDistrictPair, type DistrictMatrixRepair } from "./district-osrm-verification";

export const DISTRICT_MAX_STOPS = 750;
export const DISTRICT_MAX_SNAP_METERS = 250;
const BLOCK_SIZE = 50;
const MAX_TABLE_REQUESTS = 256;
const REQUEST_TIMEOUT_MS = 20_000;
const MAX_GEOMETRY_WAYPOINTS = 50;
// One process-wide ceiling for the configured provider, even if multiple jobs run simultaneously.
let providerActive = 0;
let providerNextStart = 0;
const providerWaiters: (() => void)[] = [];
async function providerSlot<T>(signal: AbortSignal, work: () => Promise<T>): Promise<T> {
  let reserved = false;
  if (providerActive >= 2) {
    if (providerWaiters.length >= 32) fail("Vägleverantören är upptagen. Försök igen när pågående distriktsjobb är klara.");
    await new Promise<void>((resolve, reject) => {
      const wake = () => { signal.removeEventListener("abort", abort); resolve(); };
      const abort = () => {
        const index = providerWaiters.indexOf(wake);
        if (index >= 0) providerWaiters.splice(index, 1);
        reject(new Error("Distriktsrutt: Avbruten."));
      };
      providerWaiters.push(wake);
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
    reserved = true;
  }
  if (!reserved) providerActive++;
  try {
    checkAbort(signal);
    const waitMs = Math.max(0, providerNextStart - Date.now());
    providerNextStart = Math.max(Date.now(), providerNextStart) + 100;
    if (waitMs) {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, waitMs);
        const abort = () => { clearTimeout(timer); reject(new Error("Distriktsrutt: Avbruten.")); };
        signal.addEventListener("abort", abort, { once: true });
        if (signal.aborted) abort();
      });
    }
    checkAbort(signal);
    return await work();
  } finally {
    const waiter = providerWaiters.shift();
    if (waiter) waiter(); // Transfer this occupied slot to the waiting request.
    else providerActive--;
  }
}

export interface DistrictCoordinate { latitude: number; longitude: number }
export interface DistrictEndpoint extends Partial<DistrictCoordinate> { pointId?: string }
export interface DistrictInput {
  points: (DistrictCoordinate & { id: string })[];
  mode: "loop" | "open";
  start: DistrictEndpoint;
  end?: DistrictEndpoint;
  serviceMinutes: number;
}
export interface DistrictResult {
  orderedPointIds: string[];
  distanceMeters: number;
  driveSeconds: number;
  geometry: DistrictCoordinate[];
  warnings: string[];
  matrixRepairs?: DistrictMatrixRepair[];
}
export interface DistrictCallbacks {
  onProgress: (progress: number) => Promise<void> | void;
  isCancelled: () => Promise<boolean> | boolean;
}
export interface DistrictTable {
  distances: (number | null)[][];
  durations: (number | null)[][];
  matrixRepairs?: DistrictMatrixRepair[];
}
export interface DistrictRoute {
  geometry: DistrictCoordinate[];
  waypoints: DistrictCoordinate[];
}
export interface DistrictRoadProvider {
  /** Both blocks are in the same order as the returned rectangular table. Distances in meters, durations in seconds. */
  table(sources: DistrictCoordinate[], destinations: DistrictCoordinate[], signal: AbortSignal): Promise<DistrictTable>;
  /** Must return road geometry in traversal order and a snapped waypoint for every requested coordinate. */
  route(points: DistrictCoordinate[], signal: AbortSignal): Promise<DistrictRoute>;
  /** Explicit versioned dataset identity; enables reuse across jobs when supplied. */
  cacheKey?: string;
  /** Aggregate provider corrections only; no original coordinates or credentials. */
  warnings?: () => string[];
}
export interface DistrictSolveOptions {
  provider?: DistrictRoadProvider;
  signal?: AbortSignal;
  /** Defaults to false; no process-wide retention of road matrices unless explicitly requested. */
  warmMatrixCache?: boolean;
  /** Aggregate diagnostics only; never emits coordinates, identifiers or matrix contents. */
  onMeasurements?: (measurements: DistrictMeasurements) => void;
}
export interface DistrictMeasurements {
  matrixMilliseconds: number;
  solverMilliseconds: number;
  geometryMilliseconds: number;
  uniqueCoordinates: number;
  matrixCells: number;
  tableRequests: number;
  matrixCacheHit: boolean;
  asymmetricDistancePairs: number;
  sourceOrderDistanceMeters: number;
}

function fail(message: string): never { throw new Error(`Distriktsrutt: ${message}`); }
function providerDetail(error: unknown): string {
  return error instanceof Error && error.message.startsWith("Distriktsrutt: ")
    ? ` ${error.message.slice("Distriktsrutt: ".length)}`
    : " Kontrollera OSRM-serverns tillgänglighet och vägtäckning.";
}
function validCoordinate(c: DistrictCoordinate): boolean {
  return Number.isFinite(c.latitude) && Number.isFinite(c.longitude) &&
    Math.abs(c.latitude) <= 90 && Math.abs(c.longitude) <= 180;
}
function geographicDistanceMeters(a: DistrictCoordinate, b: DistrictCoordinate): number {
  const radians=Math.PI/180;
  const lat=(b.latitude-a.latitude)*radians, lon=(b.longitude-a.longitude)*radians;
  const h=Math.sin(lat/2)**2+Math.cos(a.latitude*radians)*Math.cos(b.latitude*radians)*Math.sin(lon/2)**2;
  return 6371000*2*Math.asin(Math.sqrt(Math.min(1,Math.max(0,h))));
}
function assertRoadSnaps(requested: DistrictCoordinate[], snaps: DistrictCoordinate[]): void {
  if(snaps.length!==requested.length) fail("OSRM saknar väganknytning för varje efterfrågad punkt.");
  for(let i=0;i<requested.length;i++) {
    if(!validCoordinate(snaps[i]) || geographicDistanceMeters(requested[i],snaps[i])>DISTRICT_MAX_SNAP_METERS) {
      fail(`Punkt ${i+1} saknar giltig väganknytning inom ${DISTRICT_MAX_SNAP_METERS} meter. Kontrollera adressen och vägtäckningen; inga stopp har tagits bort.`);
    }
  }
}
function coordKey(c: DistrictCoordinate): string { return `${c.latitude},${c.longitude}`; }
function near(a: DistrictCoordinate, b: DistrictCoordinate, tolerance = 0.000025): boolean {
  return Math.abs(a.latitude - b.latitude) <= tolerance && Math.abs(a.longitude - b.longitude) <= tolerance;
}
function checkAbort(signal?: AbortSignal): void {
  if (signal?.aborted) fail("Avbruten.");
}

/** Construct a provider for a resolved, immutable routing-server binding. */
export function createDistrictOsrmProvider(raw: string, cacheKey?: string, headers?: Record<string, string>,
  bulk?: { datasetIdentity: string; snapLimits?: ReadonlyMap<string, number> }): DistrictRoadProvider {
  let base: URL;
  try { base = new URL(raw); } catch { return fail("OSRM_BASE_URL är ogiltig."); }
  if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
      /(^|\.)router\.project-osrm\.org$/i.test(base.hostname)) {
    fail("Den publika OSRM-demonstrationen får inte användas för distriktsmatriser. Konfigurera en dedikerad OSRM-server för bilvägar.");
  }
  const prefix = base.toString().replace(/\/$/, "");
  const providerIdentity = cacheKey ?? `osrm-driving:${prefix}`;
  // Providers are constructed per bound job. Share this budget across its blocks.
  let repairsStarted = 0;
  const request = async (path: string, signal: AbortSignal): Promise<any> => {
    return providerSlot(signal, async () => {
      const response = await fetch(`${prefix}${path}`, { signal, redirect: "error", ...(headers ? { headers } : {}) });
      if (bulk && response.headers.get("x-osrm-dataset-id") !== bulk.datasetIdentity)
        fail("Vägdatatjänstens datasetidentitet saknas eller har ändrats. Inget resultat används.");
      const body: any = await response.json().catch(()=>undefined);
      if(body?.code==="NoSegment") fail(`En eller flera punkter saknar väganknytning inom ${DISTRICT_MAX_SNAP_METERS} meter. Kontrollera adresserna och vägtäckningen; inga stopp har tagits bort.`);
      if (!response.ok) fail(`OSRM svarade med HTTP ${response.status}. Kontrollera leverantörens kapacitet och vägtäckning.`);
      if (body?.code !== "Ok") fail(`OSRM svarade med ${String(body?.code ?? "ogiltigt svar")}. Kontrollera vägtäckningen.`);
      return body;
    });
  };
  const coords = (points: DistrictCoordinate[]) =>
    points.map(p => `${p.longitude},${p.latitude}`).join(";");
  const radiuses=(points:DistrictCoordinate[])=>points.map(p=>bulk?.snapLimits?.get(coordKey(p)) ?? DISTRICT_MAX_SNAP_METERS).join(";");
  const validateSnaps=(requested:DistrictCoordinate[], actual:DistrictCoordinate[])=>{
    if (!bulk?.snapLimits) return assertRoadSnaps(requested,actual);
    if (actual.length!==requested.length) fail("Väganknytningar saknas.");
    requested.forEach((p,i)=>{
      if (!validCoordinate(actual[i])) fail("Ogiltig väganknytning.");
      const limit=bulk.snapLimits!.get(coordKey(p)) ?? DISTRICT_MAX_SNAP_METERS;
      if(geographicDistanceMeters(p,actual[i])>limit)
        fail(`Punkt ${i+1} saknar väganknytning inom det uttryckligen godkända avståndet ${limit} meter.`);
    });
  };
  const snaps=(values:any):DistrictCoordinate[]=>{
    if(!Array.isArray(values)) fail("OSRM saknar verifierbar väganknytning.");
    return values.map(value=>({
      longitude:value?.location?.[0],latitude:value?.location?.[1],
    }));
  };
  return {
    cacheKey: providerIdentity,
    ...(bulk?{warnings:()=>repairsStarted?[`${repairsStarted} negativa OSRM-avstånd har verifierats separat med bilvägsgeometri och giltiga kostnader. Verifieringsbevis sparas med jobbet; originalkoordinater är oförändrade.`]:[]}:{}),
    async table(sources, destinations, signal) {
      // Same-block calls use one coordinate array, rather than duplicating 50 coordinates.
      const same = sources === destinations;
      // OSRM requires at least two coordinates even for a deduplicated 1×1
      // table. Repeat the coordinate in transport only; preserve matrix shape.
      const all = same && sources.length===1 ? [sources[0],sources[0]] :
        same ? sources : [...sources, ...destinations];
      const src = sources.map((_, i) => i).join(";");
      const dst = destinations.map((_, i) => i + (same ? 0 : sources.length)).join(";");
      const body = await request(`/table/v1/driving/${coords(all)}?annotations=distance,duration&sources=${src}&destinations=${dst}&radiuses=${radiuses(all)}`, signal);
      const sourceSnaps = snaps(body.sources), destinationSnaps = snaps(body.destinations);
      validateSnaps(sources, sourceSnaps);
      validateSnaps(destinations, destinationSnaps);
      // Validate the entire block before spending any verification requests.
      if (!Array.isArray(body.distances) || !Array.isArray(body.durations) ||
          body.distances.length !== sources.length || body.durations.length !== sources.length)
        fail("Vägmatrisen saknar rader.");
      const pending: { i: number; j: number; d: number; t: number }[] = [];
      for (let i = 0; i < sources.length; i++) {
        if (!Array.isArray(body.distances[i]) || !Array.isArray(body.durations[i]) ||
            body.distances[i].length !== destinations.length || body.durations[i].length !== destinations.length)
          fail("Vägmatrisen saknar kolumner.");
        for (let j = 0; j < destinations.length; j++) {
          const d = body.distances[i][j], t = body.durations[i][j];
          if (typeof d !== "number" || !Number.isFinite(d) ||
              typeof t !== "number" || !Number.isFinite(t) || t < 0)
            fail(`Vägförbindelse saknas eller är ogiltig från matrisrad ${i + 1} till kolumn ${j + 1}.`);
          if (d < 0) pending.push({ i, j, d, t });
        }
      }
      if (repairsStarted + pending.length > MAX_DISTRICT_MATRIX_REPAIRS)
        fail(`För många negativa matrisposter (gräns ${MAX_DISTRICT_MATRIX_REPAIRS}). Vägdatatjänsten måste granskas.`);
      repairsStarted += pending.length;
      const matrixRepairs: DistrictMatrixRepair[] = [];
      for (const { i, j, d, t } of pending) {
        checkAbort(signal);
        const requested = [sources[i], destinations[j]];
        const waypoints = [sourceSnaps[i], destinationSnaps[j]];
        // Uses the same immutable endpoint, credentials, limiter and cancellation.
        const verification = await request(`/route/v1/driving/${coords(requested)}?overview=full&geometries=geojson&steps=false&continue_straight=false&radiuses=${radiuses(requested)}`, signal);
        checkAbort(signal);
        const replacement = verifiedDistrictPair(verification, requested, waypoints, validateSnaps, geographicDistanceMeters);
        matrixRepairs.push(structuredClone({
          providerIdentity, requested, table: { distance: d, duration: t, waypoints },
          verification, replacement,
        }));
        body.distances[i][j] = replacement.distance;
        body.durations[i][j] = replacement.duration;
      }
      return { distances: body.distances, durations: body.durations, matrixRepairs };
    },
    async route(points, signal) {
      // Bulk waypoints are visits, not pass-through points. Permit turning at
      // a served stop, matching independent directed Table legs and GTB.
      const body = await request(`/route/v1/driving/${coords(points)}?overview=full&geometries=geojson&steps=false&radiuses=${radiuses(points)}${bulk ? "&continue_straight=false" : ""}`, signal);
      const coordinates = body.routes?.[0]?.geometry?.coordinates;
      const waypoints = body.waypoints;
      if (!Array.isArray(coordinates) || !Array.isArray(waypoints)) fail("OSRM skickade ingen väggeometri eller inga väganknutna punkter.");
      validateSnaps(points,snaps(waypoints));
      return {
        geometry: coordinates.map((xy: unknown) => {
          if (!Array.isArray(xy) || xy.length < 2) fail("OSRM skickade ogiltig väggeometri.");
          return { latitude: xy[1], longitude: xy[0] };
        }),
        waypoints: waypoints.map((w: any) => {
          if (!Array.isArray(w?.location) || w.location.length < 2) fail("OSRM skickade ogiltiga väganknutna punkter.");
          return { latitude: w.location[1], longitude: w.location[0] };
        }),
      };
    },
  };
}

/** No implicit public-demo fallback. A shared, operator-configured OSRM base is sufficient. */
export function configuredDistrictOsrmProvider(): DistrictRoadProvider {
  const selected = selectDistrictProviderEnvironment();
  if (!selected) fail("OSRM_BASE_URL saknas. Konfigurera en godkänd vägdataleverantör innan distriktsoptimering kan starta.");
  return createDistrictOsrmProvider(
    selected.baseUrl,
    undefined,
    selected.token ? { Authorization: `Bearer ${selected.token}` } : undefined,
  );
}

// Matrix is owned by a solve invocation; optional small TTL cache stores COPIES and never exposes mutable arrays.
const cache = new Map<string, { distance: Float64Array; duration: Float64Array; matrixRepairs: DistrictMatrixRepair[]; expires: number; bytes: number }>();
const CACHE_LIMIT_BYTES = 16 * 1024 * 1024;
function getCached(key: string): { distance: Float64Array; duration: Float64Array; matrixRepairs: DistrictMatrixRepair[] } | undefined {
  const value = cache.get(key);
  if (!value) return undefined;
  if (value.expires < Date.now()) { cache.delete(key); return undefined; }
  cache.delete(key); cache.set(key, value);
  return { distance: value.distance.slice(), duration: value.duration.slice(), matrixRepairs: structuredClone(value.matrixRepairs) };
}
function putCached(key: string, distance: Float64Array, duration: Float64Array, matrixRepairs: DistrictMatrixRepair[]): void {
  const bytes = distance.byteLength + duration.byteLength + Buffer.byteLength(JSON.stringify(matrixRepairs));
  if (bytes > CACHE_LIMIT_BYTES) return;
  cache.delete(key);
  cache.set(key, { distance: distance.slice(), duration: duration.slice(), matrixRepairs: structuredClone(matrixRepairs), expires: Date.now() + 10 * 60_000, bytes });
  let total = 0;
  for (const value of cache.values()) total += value.bytes;
  while (total > CACHE_LIMIT_BYTES) {
    const oldest = cache.keys().next().value;
    if (!oldest) break;
    total -= cache.get(oldest)!.bytes;
    cache.delete(oldest);
  }
}

async function withRequestTimeout<T>(work: (signal: AbortSignal) => Promise<T>, signal: AbortSignal): Promise<T> {
  const controller = new AbortController();
  const cancel = () => controller.abort();
  signal.addEventListener("abort", cancel, { once: true });
  const timer = setTimeout(cancel, REQUEST_TIMEOUT_MS);
  try {
    checkAbort(signal);
    // Also settle if an injected provider neglects to honor AbortSignal.
    return await Promise.race([
      work(controller.signal),
      new Promise<T>((_resolve, reject) => {
        if (controller.signal.aborted) { reject(new Error("Begäran avbröts.")); return; }
        controller.signal.addEventListener("abort", () => reject(new Error("Begäran avbröts.")), { once: true });
      }),
    ]);
  } catch (error) {
    if (signal.aborted) fail("Avbruten.");
    if (controller.signal.aborted) fail(`Vägleverantören svarade inte inom ${REQUEST_TIMEOUT_MS / 1000} sekunder. Använd en OSRM-server med tillräcklig kapacitet.`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", cancel);
  }
}

function resolveEndpoint(endpoint: DistrictEndpoint, points: DistrictInput["points"], label: string): DistrictCoordinate {
  if (endpoint.pointId !== undefined) {
    const point = points.find(p => p.id === endpoint.pointId);
    if (!point) fail(`${label} har ett punkt-ID som inte finns bland valda stopp.`);
    return { latitude: point.latitude, longitude: point.longitude };
  }
  const c = { latitude: endpoint.latitude!, longitude: endpoint.longitude! };
  if (!validCoordinate(c)) fail(`${label} kräver giltig latitud och longitud i WGS84 eller ett valt punkt-ID.`);
  return c;
}

/** Directed, complete, private matrix; request count = ceil(uniqueCoordinates/50)^2. */
export async function buildMatrix(coords: DistrictCoordinate[], provider: DistrictRoadProvider, signal: AbortSignal,
  report: (fraction: number) => Promise<void>, cacheEnabled: boolean,
  limits = { blockSize: BLOCK_SIZE, maxRequests: MAX_TABLE_REQUESTS, maxBytes: 16 * 1024 * 1024 }) {
  const unique: DistrictCoordinate[] = [];
  const indices: number[] = [];
  const byCoordinate = new Map<string, number>();
  for (const c of coords) {
    const key = coordKey(c);
    let index = byCoordinate.get(key);
    if (index === undefined) { index = unique.length; byCoordinate.set(key, index); unique.push(c); }
    indices.push(index);
  }
  const n = unique.length;
  const hash = cacheEnabled && provider.cacheKey
    ? createHash("sha256").update(JSON.stringify([provider.cacheKey, unique])).digest("hex") : undefined;
  const existing = hash && getCached(hash);
  if (existing) {
    await report(1);
    return { ...existing, indices, width: n, cacheHit: true, tableRequests: 0 };
  }
  const count = Math.ceil(n / limits.blockSize);
  if (count * count > limits.maxRequests || 16*n*n > limits.maxBytes)
    fail(`Vägmatrisen överskrider jobbets anrops- eller minnesbudget. Dela upp underlaget.`);
  const distance = new Float64Array(n * n);
  const duration = new Float64Array(n * n);
  distance.fill(NaN); duration.fill(NaN);
  const matrixRepairs: DistrictMatrixRepair[] = [];
  let next = 0, done = 0;
  const worker = async () => {
    while (next < count * count) {
      checkAbort(signal);
      const block = next++;
      const row = Math.floor(block / count) * limits.blockSize, col = block % count * limits.blockSize;
      const sources = unique.slice(row, row + limits.blockSize);
      const destinations = row === col ? sources : unique.slice(col, col + limits.blockSize);
      let result: DistrictTable;
      try { result = await withRequestTimeout(s => provider.table(sources, destinations, s), signal); }
      catch (error) {
        if (signal.aborted) fail("Avbruten.");
        fail(`Vägmatrisens block ${Math.floor(block / count) + 1}/${block % count + 1} misslyckades.${providerDetail(error)}`);
      }
      if (!Array.isArray(result?.distances) || !Array.isArray(result?.durations) ||
          result.distances.length !== sources.length || result.durations.length !== sources.length)
        fail(`Vägmatrisens block ${block + 1} saknar rader.`);
      for (let i = 0; i < sources.length; i++) {
        if (!Array.isArray(result.distances[i]) || !Array.isArray(result.durations[i]) ||
            result.distances[i].length !== destinations.length || result.durations[i].length !== destinations.length)
          fail(`Vägmatrisens block ${block + 1} saknar kolumner.`);
        for (let j = 0; j < destinations.length; j++) {
          const from = row + i, to = col + j, d = result.distances[i][j], t = result.durations[i][j];
          if (typeof d !== "number" || !Number.isFinite(d) || d < 0 ||
              typeof t !== "number" || !Number.isFinite(t) || t < 0)
            fail(`Vägförbindelse saknas eller är ogiltig från matrisrad ${from + 1} till kolumn ${to + 1}. Kontrollera oåtkomliga stopp och OSRM:s vägtäckning.`);
          distance[from * n + to] = from === to ? 0 : d;
          duration[from * n + to] = from === to ? 0 : t;
        }
      }
      matrixRepairs.push(...structuredClone(result.matrixRepairs ?? []));
      await report(++done / (count * count));
    }
  };
  await Promise.all(Array.from({ length: Math.min(2, count * count) }, worker));
  // Never retain a partial or malformed matrix.
  for (let i = 0; i < n * n; i++)
    if (!Number.isFinite(distance[i]) || !Number.isFinite(duration[i])) fail(`Vägmatrisen är ofullständig vid cell ${i}. Försök igen med en fungerande OSRM-server.`);
  if (hash) putCached(hash, distance, duration, matrixRepairs);
  return { distance, duration, matrixRepairs, indices, width: n, cacheHit: false, tableRequests: count * count };
}

async function optimize(stops: number[], start: number, terminal: number | undefined,
  cost: (a: number, b: number) => number, signal: AbortSignal, pulse: () => Promise<void>): Promise<number[]> {
  const score = (order: number[]) => {
    let sum = 0, prev = start;
    for (const node of order) { sum += cost(prev, node); prev = node; }
    return sum + (terminal === undefined ? 0 : cost(prev, terminal));
  };
  // Four deterministic starts plus a cheapest-insertion construction.
  let best: number[] = [];
  let bestScore = Infinity;
  const seeds = [undefined, ...stops.slice().sort((a, b) => cost(start, a) - cost(start, b)).slice(0, 3)];
  for (const seed of seeds) {
    const unvisited = new Set(stops);
    const route: number[] = [];
    let prev = start;
    if (seed !== undefined) { route.push(seed); unvisited.delete(seed); prev = seed; }
    while (unvisited.size) {
      checkAbort(signal);
      let chosen = -1, lowest = Infinity;
      for (const candidate of unvisited) {
        const value = cost(prev, candidate) +
          (terminal === undefined ? 0 : 0.15 * cost(candidate, terminal));
        if (value < lowest) { chosen = candidate; lowest = value; }
      }
      route.push(chosen); unvisited.delete(chosen); prev = chosen;
      if (route.length % 64 === 0) await pulse();
    }
    const value = score(route);
    if (value < bestScore) { best = route; bestScore = value; }
  }
  // Cheapest insertion handles endpoint constraints better than nearest-neighbor alone.
  const inserted: number[] = [];
  const remaining = new Set(stops);
  while (remaining.size) {
    checkAbort(signal);
    let min = Infinity, chosen = -1, position = 0;
    for (const node of remaining) {
      for (let pos = 0; pos <= inserted.length; pos++) {
        const before = pos === 0 ? start : inserted[pos - 1];
        const after = pos === inserted.length ? terminal : inserted[pos];
        const delta = cost(before, node) + (after === undefined ? 0 : cost(node, after) - cost(before, after));
        if (delta < min) { min = delta; chosen = node; position = pos; }
      }
    }
    inserted.splice(position, 0, chosen);
    remaining.delete(chosen);
    if (inserted.length % 16 === 0) await pulse();
  }
  if (score(inserted) < bestScore) best = inserted;

  // Bounded directed relocate and 2-opt passes. Reverse internal arcs are accounted for.
  const n = best.length;
  for (let pass = 0; pass < 2; pass++) {
    let improved = false, ticks = 0;
    for (let i = 0; i < n; i++) {
      const before = i === 0 ? start : best[i - 1], node = best[i];
      const after = i === n - 1 ? terminal : best[i + 1];
      const remove = (after === undefined ? 0 : cost(before, after) - cost(node, after)) - cost(before, node);
      for (let j = 0; j < n; j++) {
        if (j === i) continue;
        // j is the insertion position in the shortened array.
        const b = j === 0 ? start : best[j - 1 + (j > i ? 1 : 0)];
        const a = j === n - 1 ? terminal : best[j + (j >= i ? 1 : 0)];
        const delta = remove + cost(b, node) + (a === undefined ? 0 : cost(node, a) - cost(b, a));
        if (delta < -1e-7) {
          best.splice(i, 1); best.splice(j, 0, node);
          improved = true; break;
        }
        if (++ticks % 16384 === 0) await pulse();
      }
      if (improved) break;
    }
    if (improved) continue;
    const reverseDelta = new Float64Array(n);
    for (let k = 1; k < n; k++)
      reverseDelta[k] = reverseDelta[k - 1] + cost(best[k], best[k - 1]) - cost(best[k - 1], best[k]);
    for (let i = 0; i < n - 1 && !improved; i++) {
      const before = i === 0 ? start : best[i - 1];
      for (let j = i + 1; j < n; j++) {
        const after = j === n - 1 ? terminal : best[j + 1];
        const delta = cost(before, best[j]) - cost(before, best[i]) +
          (after === undefined ? 0 : cost(best[i], after) - cost(best[j], after)) +
          reverseDelta[j] - reverseDelta[i];
        if (delta < -1e-7) { best.splice(i, j - i + 1, ...best.slice(i, j + 1).reverse()); improved = true; break; }
        if (++ticks % 16384 === 0) await pulse();
      }
    }
    if (!improved) break;
  }
  return best;
}

async function roadGeometry(ordered: DistrictCoordinate[], provider: DistrictRoadProvider,
  signal: AbortSignal, report: (fraction: number) => Promise<void>): Promise<DistrictCoordinate[]> {
  const geometry: DistrictCoordinate[] = [];
  let previousSeam: DistrictCoordinate | undefined;
  const chunks = Math.max(1, Math.ceil((ordered.length - 1) / (MAX_GEOMETRY_WAYPOINTS - 1)));
  for (let from = 0, chunk = 0; from < ordered.length - 1; from += MAX_GEOMETRY_WAYPOINTS - 1, chunk++) {
    checkAbort(signal);
    const points = ordered.slice(from, from + MAX_GEOMETRY_WAYPOINTS);
    let route: DistrictRoute;
    try { route = await withRequestTimeout(s => provider.route(points, s), signal); }
    catch (error) {
      if (signal.aborted) fail("Avbruten.");
      fail(`Väggeometrins del ${chunk + 1} misslyckades.${providerDetail(error)}`);
    }
    if (!Array.isArray(route?.geometry) || route.geometry.length < 2 ||
        !Array.isArray(route.waypoints) || route.waypoints.length !== points.length ||
        !route.geometry.every(validCoordinate) || !route.waypoints.every(validCoordinate))
      fail(`Väggeometrins del ${chunk + 1} är ofullständig eller ogiltig.`);
    assertRoadSnaps(points,route.waypoints);
    // Coordinates can snap to the road; seam comparisons are between provider snaps, not input GPS.
    if (previousSeam && !near(previousSeam, route.waypoints[0]))
      fail(`Väggeometrins skarv ${chunk + 1} hänger inte ihop. Kontrollera att OSRM ger konsekventa svar.`);
    if (!near(route.geometry[0], route.waypoints[0]) ||
        !near(route.geometry[route.geometry.length - 1], route.waypoints[route.waypoints.length - 1]))
      fail(`Väggeometrins del ${chunk + 1} börjar eller slutar inte vid rätt väganknuten punkt.`);
    previousSeam = route.waypoints[route.waypoints.length - 1];
    if (geometry.length && !near(geometry[geometry.length - 1], route.geometry[0]))
      fail(`Väggeometrins del ${chunk + 1} har en bruten skarv.`);
    geometry.push(...(geometry.length ? route.geometry.slice(1) : route.geometry));
    await report((chunk + 1) / chunks);
  }
  return geometry;
}

/** Returns road-only directed optimization. serviceMinutes is informational and does not alter driveSeconds. */
export async function solveDistrict(input: DistrictInput, callbacks: DistrictCallbacks,
  options: DistrictSolveOptions = {}): Promise<DistrictResult> {
  if (!Array.isArray(input.points) || input.points.length < 1 || input.points.length > DISTRICT_MAX_STOPS)
    fail(`Välj 1–${DISTRICT_MAX_STOPS} stopp. Dela upp större zoner före optimering; inga stopp har tagits bort.`);
  if (input.mode !== "loop" && input.mode !== "open") fail("Välj sluten slinga eller öppen ordning.");
  if (input.mode === "loop" && input.end) fail("En sluten slinga kan inte ha en separat fast slutpunkt.");
  if (input.mode === "open" && input.points.length > 1 &&
      input.start?.pointId !== undefined && input.start.pointId === input.end?.pointId)
    fail("Samma stopp kan inte vara både först och sist i en öppen ordning med flera stopp. Välj en annan slutpunkt.");
  if (!Number.isFinite(input.serviceMinutes) || input.serviceMinutes < 0) fail("Servicetid måste vara ett tal som är minst noll.");
  const ids = new Set<string>();
  for (const p of input.points) {
    if (typeof p.id !== "string" || !p.id || ids.has(p.id) || !validCoordinate(p))
      fail("Stopp-ID måste vara unika och alla stopp måste ha giltiga WGS84-koordinater.");
    ids.add(p.id);
  }
  const start = resolveEndpoint(input.start, input.points, "Startpunkten");
  const end = input.mode === "loop" ? start :
    input.end ? resolveEndpoint(input.end, input.points, "Slutpunkten") : undefined;
  const provider = options.provider ?? configuredDistrictOsrmProvider();
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) controller.abort();
  // Poll cancellation while transport is in flight, not only between optimization iterations.
  let polling = false, pollError: unknown;
  const poll = async () => {
    if (polling || controller.signal.aborted) return;
    polling = true;
    try { if (await callbacks.isCancelled()) controller.abort(); }
    catch (error) { pollError = error; controller.abort(); }
    finally { polling = false; }
  };
  const interval = setInterval(() => { void poll(); }, 300);
  const pulse = async () => {
    await yieldToEventLoop();
    await poll();
    if (pollError) throw pollError;
    checkAbort(controller.signal);
  };
  try {
    await poll();
    checkAbort(controller.signal);
    const nodes = [start, ...input.points, ...(end && input.mode === "open" ? [end] : [])];
    let lastProgress = 0;
    let progressQueue = Promise.resolve();
    const progress = async (value: number) => {
      checkAbort(controller.signal);
      const rounded = Math.max(lastProgress, Math.min(99, Math.floor(value)));
      if (rounded > lastProgress) {
        lastProgress = rounded;
        progressQueue = progressQueue.then(() => callbacks.onProgress(rounded));
        await progressQueue;
      }
    };
    const matrixStarted = performance.now();
    const matrix = await buildMatrix(nodes, provider, controller.signal, fraction => progress(fraction * 70), !!options.warmMatrixCache);
    const matrixMilliseconds = performance.now() - matrixStarted;
    const idx = matrix.indices, width = matrix.width;
    const cost = (a: number, b: number) => matrix.distance[idx[a] * width + idx[b]];
    const duration = (a: number, b: number) => matrix.duration[idx[a] * width + idx[b]];
    // A selected endpoint is a VISIT, not just a coordinate: pin its ID in the permutation.
    // Excluding pinned visits from the heuristic prevents a duplicate-coordinate tie from
    // silently choosing the wrong source row as the first or last stop.
    const first = input.start.pointId === undefined ? undefined :
      input.points.findIndex(p => p.id === input.start.pointId) + 1;
    const last = input.mode === "open" && input.end?.pointId !== undefined ?
      input.points.findIndex(p => p.id === input.end!.pointId) + 1 : undefined;
    const stopIndices = input.points.map((_, i) => i + 1)
      .filter(i => i !== first && i !== last);
    const terminal = last ?? (end ? (input.mode === "loop" ? 0 : nodes.length - 1) : undefined);
    const solverStarted = performance.now();
    const middle = await optimize(stopIndices, first ?? 0, terminal, cost, controller.signal, pulse);
    const solverMilliseconds = performance.now() - solverStarted;
    const order = [...(first === undefined ? [] : [first]), ...middle,
      ...(last === undefined || last === first ? [] : [last])];
    if (order.length !== input.points.length || new Set(order).size !== input.points.length)
      fail("Alla valda stopp kunde inte bevaras i resultatet. Inget resultat har publicerats.");
    await progress(85);
    const visits = [0, ...order];
    let distanceMeters = 0, driveSeconds = 0;
    for (let k = 1; k < visits.length; k++) {
      distanceMeters += cost(visits[k - 1], visits[k]);
      driveSeconds += duration(visits[k - 1], visits[k]);
    }
    // The fixed-end stop is already present as the final visit. Still account for the
    // terminal edge (zero for the identical node), but do not ask OSRM to visit its ID twice.
    if (terminal !== undefined) {
      distanceMeters += cost(visits[visits.length - 1], terminal);
      driveSeconds += duration(visits[visits.length - 1], terminal);
      if (terminal !== visits[visits.length - 1]) visits.push(terminal);
    }
    const geometryStarted = performance.now();
    const geometry = await roadGeometry(visits.map(i => nodes[i]), provider, controller.signal,
      fraction => progress(85 + fraction * 14));
    const geometryMilliseconds = performance.now() - geometryStarted;
    await poll(); checkAbort(controller.signal);
    if (options.onMeasurements) {
      let asymmetricDistancePairs = 0;
      for (let a = 0; a < width; a++)
        for (let b = a + 1; b < width; b++)
          if (Math.abs(matrix.distance[a * width + b] - matrix.distance[b * width + a]) > 1)
            asymmetricDistancePairs++;
      const sourceOrder = [...(first === undefined ? [] : [first]), ...stopIndices,
        ...(last === undefined ? [] : [last])];
      let sourceOrderDistanceMeters = 0, previous = 0;
      for (const node of sourceOrder) { sourceOrderDistanceMeters += cost(previous, node); previous = node; }
      if (terminal !== undefined) sourceOrderDistanceMeters += cost(previous, terminal);
      options.onMeasurements({ matrixMilliseconds, solverMilliseconds, geometryMilliseconds,
        uniqueCoordinates: width, matrixCells: width * width, tableRequests: matrix.tableRequests,
        matrixCacheHit: matrix.cacheHit, asymmetricDistancePairs, sourceOrderDistanceMeters });
    }
    await callbacks.onProgress(100);
    return { orderedPointIds: order.map(i => input.points[i - 1].id), distanceMeters,
      driveSeconds, geometry, warnings: [],
      ...(matrix.matrixRepairs.length ? { matrixRepairs: matrix.matrixRepairs } : {}) };
  } finally {
    clearInterval(interval);
    options.signal?.removeEventListener("abort", onAbort);
    controller.abort();
  }
}
