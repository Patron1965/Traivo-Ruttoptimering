const OSRM_BASE_URL = process.env.OSRM_BASE_URL || "https://router.project-osrm.org";
const MAX_CACHE_SIZE = 50000;
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
  return `${geohashKey(lat1, lon1)}|${geohashKey(lat2, lon2)}`;
}

class LRUCache {
  private cache = new Map<string, DistanceDuration>();
  private maxSize: number;

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

  set(key: string, value: DistanceDuration): void {
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
    this.cache.clear();
  }
}

const osrmCache = new LRUCache(MAX_CACHE_SIZE);

let osrmAvailable = true;
let lastFailureTime = 0;
const RETRY_COOLDOWN_MS = 60000;

export function getOsrmCacheSize(): number {
  return osrmCache.size;
}

export function clearOsrmCache(): void {
  osrmCache.clear();
}

export function isOsrmConfigured(): boolean {
  return !!process.env.OSRM_BASE_URL;
}

export function getCachedOsrmDistance(
  lat1: number, lon1: number,
  lat2: number, lon2: number
): DistanceDuration | undefined {
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
  coords: { lat: number; lon: number }[]
): Promise<OsrmTableResponse | null> {
  if (!osrmAvailable && Date.now() - lastFailureTime < RETRY_COOLDOWN_MS) {
    return null;
  }

  const coordStr = coords.map(c => `${c.lon},${c.lat}`).join(";");
  const url = `${OSRM_BASE_URL}/table/v1/driving/${coordStr}?annotations=distance,duration`;

  try {
    const res = await fetchWithTimeout(url, OSRM_TIMEOUT_MS);
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
    osrmAvailable = true;
    return data;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`OSRM Table API fetch failed: ${msg}`);
    osrmAvailable = false;
    lastFailureTime = Date.now();
    return null;
  }
}

export async function precomputeDistanceMatrix(
  coordinates: { lat: number; lon: number }[]
): Promise<boolean> {
  if (coordinates.length < 2) return false;

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

  let success = false;
  let pairsComputed = 0;

  if (uniqueCoords.length <= MAX_TABLE_COORDS) {
    const result = await fetchOsrmTable(uniqueCoords);
    if (result) {
      success = true;
      pairsComputed += storeTableResult(uniqueCoords, uniqueCoords, result, 0, 0);
    }
  } else {
    const chunkSize = MAX_TABLE_COORDS;
    const chunks: { lat: number; lon: number }[][] = [];
    for (let i = 0; i < uniqueCoords.length; i += chunkSize) {
      chunks.push(uniqueCoords.slice(i, Math.min(i + chunkSize, uniqueCoords.length)));
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      const result = await fetchOsrmTable(chunks[ci]);
      if (result) {
        success = true;
        pairsComputed += storeTableResult(chunks[ci], chunks[ci], result, 0, 0);
      }
    }

    for (let ci = 0; ci < chunks.length; ci++) {
      for (let cj = ci + 1; cj < chunks.length; cj++) {
        const combined = [...chunks[ci], ...chunks[cj]];
        if (combined.length > MAX_TABLE_COORDS) {
          const half = Math.floor(MAX_TABLE_COORDS / 2);
          const srcSlice = chunks[ci].slice(0, half);
          const dstSlice = chunks[cj].slice(0, half);
          const block = [...srcSlice, ...dstSlice];
          const blockResult = await fetchOsrmTable(block);
          if (blockResult) {
            success = true;
            for (let s = 0; s < srcSlice.length; s++) {
              for (let d = 0; d < dstSlice.length; d++) {
                const di = srcSlice.length + d;
                storePair(srcSlice[s], dstSlice[d], blockResult, s, di);
                storePair(dstSlice[d], srcSlice[s], blockResult, di, s);
                pairsComputed += 2;
              }
            }
          }
        } else {
          const result = await fetchOsrmTable(combined);
          if (result) {
            success = true;
            const srcLen = chunks[ci].length;
            for (let s = 0; s < srcLen; s++) {
              for (let d = srcLen; d < combined.length; d++) {
                storePair(combined[s], combined[d], result, s, d);
                storePair(combined[d], combined[s], result, d, s);
                pairsComputed += 2;
              }
            }
          }
        }
      }
    }
  }

  if (success) {
    console.log(`OSRM: Pre-computed ${pairsComputed} pairs, cache size ${osrmCache.size} for ${uniqueCoords.length} coordinates`);
  }

  return success;
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
  if (dist != null && dur != null) {
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
      if (rows === cols && i === j) continue;
      const dist = result.distances[rowOffset + i]?.[colOffset + j];
      const dur = result.durations[rowOffset + i]?.[colOffset + j];
      if (dist != null && dur != null) {
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
  const key = pairKey(lat1, lon1, lat2, lon2);
  const cached = osrmCache.get(key);
  if (cached) return cached;

  if (!osrmAvailable && Date.now() - lastFailureTime < RETRY_COOLDOWN_MS) {
    return null;
  }

  const url = `${OSRM_BASE_URL}/route/v1/driving/${lon1},${lat1};${lon2},${lat2}?overview=false`;

  try {
    const res = await fetchWithTimeout(url, OSRM_TIMEOUT_MS);
    if (!res.ok) return null;

    const data = await res.json() as { code: string; routes?: { distance: number; duration: number }[] };
    if (data.code !== "Ok" || !data.routes?.[0]) return null;

    osrmAvailable = true;
    const result: DistanceDuration = {
      distanceKm: data.routes[0].distance / 1000,
      durationMin: data.routes[0].duration / 60,
    };

    osrmCache.set(key, result);
    const reverseKey = pairKey(lat2, lon2, lat1, lon1);
    osrmCache.set(reverseKey, result);

    return result;
  } catch {
    return null;
  }
}
