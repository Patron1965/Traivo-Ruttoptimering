import { randomUUID } from "node:crypto";
import { RoadDataUnavailableError } from "./road-data-policy";
import { getUsageContext } from "./usage-context";
import { recordUsage } from "./usage";
import { logger } from "../lib/logger";
import { setTimeout as delay } from "node:timers/promises";
import { ensureOrganizationServicePolicy, OrganizationServicePolicyError } from "./organization-service-policy";

export type RoadPoint = { lat: number; lon: number };
export const GEOAPIFY_MATRIX_BLOCK = 31; // At most 961 values per request (<1000).
let nextRequestAt = 0;

function validPoint(point: RoadPoint): boolean {
  return Number.isFinite(point.lat) && Number.isFinite(point.lon) &&
    Math.abs(point.lat) <= 90 && Math.abs(point.lon) <= 180;
}

function metric(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

async function request(path: string, body: unknown, timeoutMs: number, signal?: AbortSignal): Promise<any> {
  const policy = await ensureOrganizationServicePolicy();
  if (!["inherit", "geoapify"].includes(policy.roadProvider)) throw new OrganizationServicePolicyError();
  const key = process.env.GEOAPIFY_API_KEY;
  if (!key?.trim()) throw new RoadDataUnavailableError();
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs));
  const context = getUsageContext();
  const started = Date.now();
  let outcome = "failure";
  try {
    // Reserve starts across matrix, map and ETA callers in this process.
    // No automatic retries: an exhausted account must fail explicitly.
    const waitMs = Math.max(0, nextRequestAt - Date.now());
    nextRequestAt = Date.now() + waitMs + 250;
    const combinedSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
    if (waitMs) await delay(waitMs, undefined, { signal: combinedSignal });
    const url = new URL(`https://api.geoapify.com/v1/${path}`);
    url.searchParams.set("apiKey", key);
    const isRoute = path === "routing";
    if (isRoute) {
      const parameters = body as { waypoints: { location: number[] }[] };
      url.searchParams.set("waypoints", parameters.waypoints.map(p => `${p.location[1]},${p.location[0]}`).join("|"));
      url.searchParams.set("mode", "drive");
      url.searchParams.set("units", "metric");
      url.searchParams.set("traffic", "free_flow");
      url.searchParams.set("format", "geojson");
    }
    const response = await fetch(url, {
      method: isRoute ? "GET" : "POST", headers: { "Content-Type": "application/json" },
      ...(isRoute ? {} : { body: JSON.stringify(body) }), redirect: "error",
      signal: combinedSignal,
    });
    if (!response.ok) throw new RoadDataUnavailableError();
    const result = await response.json();
    outcome = "success";
    return result;
  } catch {
    // Neither provider response prose nor fetch errors may expose the API URL/key.
    throw new RoadDataUnavailableError();
  } finally {
    if (context) {
      try {
        await recordUsage({
          organizationId: context.organizationId, jobId: context.jobId, eventKey: randomUUID(),
          category: "osrm", provider: "geoapify", operation: `geoapify/${path}`,
          outcome, units: 1, durationMs: Date.now() - started,
        });
      } catch {
        logger.error({ event: "usage_ledger_write_failed", provider: "geoapify", operation: path },
          "Could not persist provider usage event");
      }
    }
  }
}

/** Preserve directed cells; missing/unreachable values are never estimated. */
export async function fetchGeoapifyMatrix(
  sources: RoadPoint[], targets: RoadPoint[], timeoutMs = 30_000,
): Promise<{ code: string; distances: (number | null)[][]; durations: (number | null)[][] }> {
  if (!sources.length || !targets.length || sources.length * targets.length > 1000 ||
      ![...sources, ...targets].every(validPoint)) throw new RoadDataUnavailableError();
  const locations = (points: RoadPoint[]) => points.map(p => ({ location: [p.lon, p.lat] }));
  const data = await request("routematrix", {
    mode: "drive", units: "metric", traffic: "free_flow",
    sources: locations(sources), targets: locations(targets),
  }, timeoutMs);
  if (!data || typeof data !== "object") throw new RoadDataUnavailableError();
  const distances = sources.map(() => targets.map((): number | null => null));
  const durations = sources.map(() => targets.map((): number | null => null));
  const seen = new Set<string>();
  if (!Array.isArray(data.sources_to_targets)) throw new RoadDataUnavailableError();
  for (const row of data.sources_to_targets) {
    if (!Array.isArray(row)) throw new RoadDataUnavailableError();
    for (const cell of row) {
      if (!cell) continue;
      const s = cell.source_index, t = cell.target_index;
      if (!Number.isInteger(s) || !Number.isInteger(t) || s < 0 || t < 0 ||
          s >= sources.length || t >= targets.length || seen.has(`${s}:${t}`)) {
        throw new RoadDataUnavailableError();
      }
      seen.add(`${s}:${t}`);
      if (metric(cell.distance) && metric(cell.time)) {
        distances[s][t] = cell.distance;
        durations[s][t] = cell.time;
      }
    }
  }
  return { code: "Ok", distances, durations };
}

function encodePolyline(points: number[][]): string {
  let lastLat = 0, lastLon = 0, encoded = "";
  const encode = (delta: number) => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    let result = "";
    while (value >= 0x20) { result += String.fromCharCode((0x20 | (value & 0x1f)) + 63); value >>>= 5; }
    return result + String.fromCharCode(value + 63);
  };
  for (const [lon, lat] of points) {
    const nextLat = Math.round(lat * 1e5), nextLon = Math.round(lon * 1e5);
    encoded += encode(nextLat - lastLat) + encode(nextLon - lastLon);
    lastLat = nextLat; lastLon = nextLon;
  }
  return encoded;
}

/** Existing map clients consume OSRM's envelope and precision-5 polyline. */
export async function fetchGeoapifyRoute(points: RoadPoint[], signal?: AbortSignal) {
  if (points.length < 2 || points.length > 100 || !points.every(validPoint)) throw new RoadDataUnavailableError();
  const data = await request("routing", {
    mode: "drive", units: "metric", traffic: "free_flow",
    waypoints: points.map(p => ({ location: [p.lon, p.lat] })),
  }, 30_000, signal);
  if (!data || typeof data !== "object") throw new RoadDataUnavailableError();
  const feature = data.features?.[0];
  const props = feature?.properties;
  const geometry = feature?.geometry;
  const coordinates: number[][] = geometry?.type === "MultiLineString" && Array.isArray(geometry.coordinates)
    ? geometry.coordinates.flat() : geometry?.type === "LineString" && Array.isArray(geometry.coordinates) ? geometry.coordinates : [];
  if (!metric(props?.distance) || !metric(props?.time) || coordinates.length < 2 ||
      !coordinates.every(p => Array.isArray(p) && p.length >= 2 && validPoint({ lat: p[1], lon: p[0] }))) {
    throw new RoadDataUnavailableError();
  }
  return {
    code: "Ok",
    routes: [{ distance: props.distance as number, duration: props.time as number, geometry: encodePolyline(coordinates) }],
  };
}
