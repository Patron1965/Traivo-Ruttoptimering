import { randomUUID } from "node:crypto";
import { logger } from "../lib/logger";
import { recordUsage } from "./usage";
import { getUsageContext, type UsageContext } from "./usage-context";
import { operationalProviderKind, operationalProviderConfigured, operationalProviderCacheKey } from "./operational-provider-config";
import { fetchGeoapifyMatrix, fetchGeoapifyRoute, GEOAPIFY_MATRIX_BLOCK } from "./geoapify-road";
import { assertOperationalRoadProvider } from "./road-data-policy";
import { ensureOrganizationServicePolicy, OrganizationServicePolicyError } from "./organization-service-policy";

const OSRM_BASE_URL = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const DEFAULT_MAX_CACHE_SIZE = 50_000;
const MAX_MATRIX_CACHE_SIZE = 1_000_000;
const OSRM_TIMEOUT_MS = 10000;
const MAX_TABLE_COORDS = 100;

interface DistanceDuration {
  distanceKm: number;
  durationMin: number;
}

function geohashKey(lat: number, lon: number): string {
  return `${Math.round(lat * 1e5)},${Math.round(lon * 1e5)}`;
}

function pairKey(lat1: number, lon1: number, lat2: number, lon2: number): string {
  return `${operationalProviderCacheKey()}:${geohashKey(lat1, lon1)}|${geohashKey(lat2, lon2)}`;
}

class LRUCache {
  private cache = new Map<string, DistanceDuration>();
  private maxSize: number;
  revision = 0;

  constructor(maxSize: number) {
    this.maxSize = maxSize;
  }

  get(key: string): DistanceDuration | undefined {
    const val = this.cache.get(key);
    if (val !== undefined) {
      this.cache.delete(key);
      this.cache.set(key, val);
    }
    return val;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  set(key: string, value: DistanceDuration): void {
    // Derived geographic graphs must not outlive a replacement or eviction.
    this.revision++;
    if (this.cache.has(key)) {
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      if (firstKey !== undefined) this.cache.delete(firstKey);
    }
    this.cache.set(key, value);
  }

  get size(): number {
    return this.cache.size;
  }

  clear(): void {
    this.revision++;
    this.cache.clear();
  }

  ensureCapacity(requiredSize: number): boolean {
    if (requiredSize > MAX_MATRIX_CACHE_SIZE) return false;
    this.maxSize = Math.max(this.maxSize, requiredSize);
    return true;
  }
}

const osrmCache = new LRUCache(DEFAULT_MAX_CACHE_SIZE);
const precomputeInFlight = new Map<string, Promise<boolean>>();

/** Changes on every road-cache write, eviction, and clear, not LRU reads. */
export function getRoadCacheRevision(): number {
  return osrmCache.revision;
}

let osrmAvailable = true;
let lastFailureTime = 0;
const RETRY_COOLDOWN_MS = 60000;

async function recordOsrmUsage(
  context: UsageContext | undefined,
  operation: "osrm/table" | "osrm/route",
  outcome: string,
  options: { units: number; durationMs?: number; cacheStatus?: string },
): Promise<void> {
  if (!context) return;
  const provider = operationalProviderKind() === "geoapify" ? "geoapify" : "osrm";
  try {
    await recordUsage({
      organizationId: context.organizationId,
      jobId: context.jobId,
      eventKey: randomUUID(),
      category: "osrm",
      provider,
      operation: provider === "geoapify" ? operation.replace("osrm/", "geoapify/") : operation,
      outcome,
      units: options.units,
      durationMs: options.durationMs,
      cacheStatus: options.cacheStatus,
    });
  } catch {
    logger.error({ event: "usage_ledger_write_failed", provider, operation }, "Could not persist provider usage event");
  }
}

export function getOsrmCacheSize(): number {
  return osrmCache.size;
}

export function clearOsrmCache(): void {
  osrmCache.clear();
}

export interface OsrmCacheStats {
  cacheSize: number;
  inFlightPrecomputes: number;
}

export function getOsrmCacheStats(): OsrmCacheStats {
  return {
    cacheSize: osrmCache.size,
    inFlightPrecomputes: precomputeInFlight.size,
  };
}

export function isOsrmConfigured(): boolean {
  return operationalProviderConfigured();
}

export function getCachedOsrmDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): DistanceDuration | undefined {
  // Analytical/offline callers keep their existing behavior when no provider
  // is configured. An explicit tenant opt-out must still deny cached road data.
  if (operationalProviderKind() === "disabled") throw new OrganizationServicePolicyError();
  const key = pairKey(lat1, lon1, lat2, lon2);
  return osrmCache.get(key);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

interface OsrmTableResponse {
  code: string;
  durations: (number | null)[][];
  distances: (number | null)[][];
}

async function fetchOsrmTable(
  coords: { lat: number; lon: number }[],
  timeoutMs = OSRM_TIMEOUT_MS,
): Promise<OsrmTableResponse | null> {
  if (!osrmAvailable && Date.now() - lastFailureTime < RETRY_COOLDOWN_MS) {
    return null;
  }

  const coordStr = coords.map(c => `${c.lon},${c.lat}`).join(";");
  const url = `${OSRM_BASE_URL}/table/v1/driving/${coordStr}?annotations=distance,duration`;

  const usageContext = getUsageContext();
  const started = Date.now();
  let usageOutcome = "failure";
  try {
    const res = await fetchWithTimeout(url, timeoutMs);
    if (!res.ok) {
      console.warn(`OSRM Table API returned ${res.status}`);
      osrmAvailable = false;
      lastFailureTime = Date.now();
      return null;
    }
    const data = await res.json() as OsrmTableResponse;
    if (data.code !== "Ok") {
      console.warn(`OSRM Table API error: ${data.code}`);
      osrmAvailable = false;
      lastFailureTime = Date.now();
      return null;
    }
    usageOutcome = "success";
    osrmAvailable = true;
    return data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`OSRM Table API fetch failed: ${msg}`);
    osrmAvailable = false;
    lastFailureTime = Date.now();
    return null;
  } finally {
    await recordOsrmUsage(usageContext, "osrm/table", usageOutcome, {
      units: 1,
      durationMs: Date.now() - started,
    });
  }
}

export interface DistanceMatrixCacheCoverage {
  complete: boolean;
  cachedPairs: number;
  totalPairs: number;
}

export function getDistanceMatrixCacheCoverage(
  coordinates: { lat: number; lon: number }[],
): DistanceMatrixCacheCoverage {
  const uniqueCoords: { lat: number; lon: number }[] = [];
  const seen = new Set<string>();
  for (const coordinate of coordinates) {
    const key = geohashKey(coordinate.lat, coordinate.lon);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCoords.push(coordinate);
    }
  }

  const totalPairs = uniqueCoords.length * Math.max(0, uniqueCoords.length - 1);
  let cachedPairs = 0;
  for (let i = 0; i < uniqueCoords.length; i++) {
    for (let j = 0; j < uniqueCoords.length; j++) {
      if (i === j) continue;
      const from = uniqueCoords[i];
      const to = uniqueCoords[j];
      if (osrmCache.has(pairKey(from.lat, from.lon, to.lat, to.lon))) {
        cachedPairs++;
      }
    }
  }

  return {
    complete: totalPairs > 0 && cachedPairs === totalPairs,
    cachedPairs,
    totalPairs,
  };
}

export async function precomputeDistanceMatrix(
  coordinates: { lat: number; lon: number }[],
  options: { timeoutMs?: number } = {},
): Promise<boolean> {
  await ensureOrganizationServicePolicy();
  assertOperationalRoadProvider();
  const uniqueCoords: { lat: number; lon: number }[] = [];
  const seen = new Set<string>();
  for (const c of coordinates) {
    const key = geohashKey(c.lat, c.lon);
    if (!seen.has(key)) {
      seen.add(key);
      uniqueCoords.push(c);
    }
  }

  if (uniqueCoords.length < 2) return false;

  // Alternatives can start together. Reuse the same matrix request while the
  // first plan is still warming the shared OSRM cache.
  assertOperationalRoadProvider();
  const requestKey = operationalProviderCacheKey() + ":" + [...uniqueCoords.map(c => geohashKey(c.lat, c.lon))].sort().join("|");
  const existing = precomputeInFlight.get(requestKey);
  if (existing) {
    await recordOsrmUsage(getUsageContext(), "osrm/table", "cache_hit", {
      units: 0,
      cacheStatus: "in_flight",
    });
    return existing;
  }

  const work = precomputeDistanceMatrixInternal(uniqueCoords, options);
  precomputeInFlight.set(requestKey, work);
  try {
    return await work;
  } finally {
    if (precomputeInFlight.get(requestKey) === work) {
      precomputeInFlight.delete(requestKey);
    }
  }
}

async function precomputeDistanceMatrixInternal(
  uniqueCoords: { lat: number; lon: number }[],
  options: { timeoutMs?: number },
): Promise<boolean> {
  const coverageBefore = getDistanceMatrixCacheCoverage(uniqueCoords);
  if (coverageBefore.complete) {
    await recordOsrmUsage(getUsageContext(), "osrm/table", "cache_hit", {
      units: 0,
      cacheStatus: "cache",
    });
    return true;
  }

  // A full road matrix must be able to coexist with unrelated entries that
  // are already in the process-wide LRU. Otherwise a large warmup can evict
  // its own earlier blocks and quietly degrade some legs to Haversine.
  const missingPairs = coverageBefore.totalPairs - coverageBefore.cachedPairs;
  if (!osrmCache.ensureCapacity(osrmCache.size + missingPairs)) {
    console.warn(
      `OSRM: Matrix for ${uniqueCoords.length} coordinates exceeds the supported complete-cache capacity`,
    );
    return false;
  }

  let pairsComputed = 0;

  if (operationalProviderKind() === "geoapify") {
    for (let s = 0; s < uniqueCoords.length; s += GEOAPIFY_MATRIX_BLOCK) {
      const sources = uniqueCoords.slice(s, s + GEOAPIFY_MATRIX_BLOCK);
      for (let t = 0; t < uniqueCoords.length; t += GEOAPIFY_MATRIX_BLOCK) {
        const targets = uniqueCoords.slice(t, t + GEOAPIFY_MATRIX_BLOCK);
        if (sources.every(from => targets.every(to =>
          geohashKey(from.lat, from.lon) === geohashKey(to.lat, to.lon) ||
          osrmCache.has(pairKey(from.lat, from.lon, to.lat, to.lon))))) continue;
        const result = await fetchGeoapifyMatrix(sources, targets, options.timeoutMs);
        pairsComputed += storeTableResult(sources, targets, result, 0, 0);
      }
    }
  } else if (uniqueCoords.length <= MAX_TABLE_COORDS) {
    const result = await fetchOsrmTable(uniqueCoords, options.timeoutMs);
    if (result) {
      pairsComputed += storeTableResult(uniqueCoords, uniqueCoords, result, 0, 0);
    }
  } else {
    // A cross-block table contains both source and destination coordinates.
    // Using 50-coordinate blocks keeps every combined request within OSRM's
    // 100-coordinate limit and, unlike the old 100+1 split, fills the entire
    // matrix instead of silently falling back to Haversine for missing pairs.
    const chunkSize = Math.floor(MAX_TABLE_COORDS / 2);
    const chunks: { lat: number; lon: number }[][] = [];
    for (let i = 0; i < uniqueCoords.length; i += chunkSize) {
      chunks.push(uniqueCoords.slice(i, Math.min(i + chunkSize, uniqueCoords.length)));
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const result = await fetchOsrmTable(chunks[ci], options.timeoutMs);
      if (result) {
        pairsComputed += storeTableResult(chunks[ci], chunks[ci], result, 0, 0);
      }
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      for (let cj = ci + 1; cj < chunks.length; cj++) {
        const combined = [...chunks[ci], ...chunks[cj]];
        const blockResult = await fetchOsrmTable(combined, options.timeoutMs);
        if (blockResult) {
          const srcLen = chunks[ci].length;
          for (let s = 0; s < srcLen; s++) {
            for (let d = srcLen; d < combined.length; d++) {
              storePair(combined[s], combined[d], blockResult, s, d);
              storePair(combined[d], combined[s], blockResult, d, s);
              pairsComputed += 2;
            }
          }
        }
      }
    }
  }

  const coverageAfter = getDistanceMatrixCacheCoverage(uniqueCoords);
  if (coverageAfter.complete) {
    console.log(`OSRM: Pre-computed ${pairsComputed} pairs, cache size ${osrmCache.size} for ${uniqueCoords.length} coordinates`);
    return true;
  }

  console.warn(
    `OSRM: Matrix warmup incomplete (${coverageAfter.cachedPairs}/${coverageAfter.totalPairs} directional pairs cached)`,
  );
  return false;
}

function storePair(
  from: { lat: number; lon: number },
  to: { lat: number; lon: number },
  result: OsrmTableResponse,
  i: number,
  j: number
): void {
  const dist = result.distances[i]?.[j];
  const dur = result.durations[i]?.[j];
  if (dist != null && dur != null && Number.isFinite(dist) && Number.isFinite(dur) && dist >= 0 && dur >= 0) {
    const key = pairKey(from.lat, from.lon, to.lat, to.lon);
    osrmCache.set(key, { distanceKm: dist / 1000, durationMin: dur / 60 });
  }
}

function storeTableResult(
  rows: { lat: number; lon: number }[],
  cols: { lat: number; lon: number }[],
  result: OsrmTableResponse,
  rowOffset: number,
  colOffset: number
): number {
  let count = 0;
  for (let i = 0; i < rows.length; i++) {
    for (let j = 0; j < cols.length; j++) {
      if (geohashKey(rows[i].lat, rows[i].lon) === geohashKey(cols[j].lat, cols[j].lon)) continue;
      const dist = result.distances[rowOffset + i]?.[colOffset + j];
      const dur = result.durations[rowOffset + i]?.[colOffset + j];
      if (dist != null && dur != null && Number.isFinite(dist) && Number.isFinite(dur) && dist >= 0 && dur >= 0) {
        const key = pairKey(rows[i].lat, rows[i].lon, cols[j].lat, cols[j].lon);
        osrmCache.set(key, { distanceKm: dist / 1000, durationMin: dur / 60 });
        count++;
      }
    }
  }
  return count;
}

export async function getOsrmDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): Promise<DistanceDuration | null> {
  await ensureOrganizationServicePolicy();
  assertOperationalRoadProvider();
  const usageContext = getUsageContext();
  const key = pairKey(lat1, lon1, lat2, lon2);
  const cached = osrmCache.get(key);
  if (cached) {
    await recordOsrmUsage(usageContext, "osrm/route", "cache_hit", {
      units: 0,
      cacheStatus: "cache",
    });
    return cached;
  }

  if (operationalProviderKind() === "geoapify") {
    const data = await fetchGeoapifyRoute([{ lat: lat1, lon: lon1 }, { lat: lat2, lon: lon2 }]);
    const route = data.routes[0];
    const result = { distanceKm: route.distance / 1000, durationMin: route.duration / 60 };
    osrmCache.set(key, result);
    return result;
  }

  if (!osrmAvailable && Date.now() - lastFailureTime < RETRY_COOLDOWN_MS) {
    return null;
  }

  const url = `${OSRM_BASE_URL}/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`;

  const started = Date.now();
  let usageOutcome = "failure";
  try {
    const res = await fetchWithTimeout(url, OSRM_TIMEOUT_MS);
    if (!res.ok) return null;

    const data = await res.json() as { code: string; routes?: { distance: number; duration: number }[] };
    if (data.code !== "Ok" || !data.routes?.[0]) return null;

    usageOutcome = "success";
    osrmAvailable = true;
    const result: DistanceDuration = {
      distanceKm: data.routes[0].distance / 1000,
      durationMin: data.routes[0].duration / 60,
    };

    osrmCache.set(key, result);
    return result;
  } catch {
    return null;
  } finally {
    await recordOsrmUsage(usageContext, "osrm/route", usageOutcome, {
      units: 1,
      durationMs: Date.now() - started,
    });
  }
}
