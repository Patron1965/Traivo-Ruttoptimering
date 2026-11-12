import { getCachedOsrmDistance } from "../osrm";
import { estimateDurationMinPredictive } from "../eta";
import { getSegmentTrafficMultiplier } from "../traffic-service";
import { getEnvCtx, EMISSION_PROFILES } from "./types";
import { requiresRoadData, RoadDataUnavailableError } from "../road-data-policy";
import { operationalProviderCacheKey } from "../operational-provider-config";

function geohashKey(lat: number, lon: number): string {
  return `${Math.round(lat * 1e5)},${Math.round(lon * 1e5)}`;
}

class DistanceMatrixCache {
  private distCache = new Map<string, number>();
  private durCache = new Map<string, number>();

  private key(lat1: number, lon1: number, lat2: number, lon2: number): string {
    return `${operationalProviderCacheKey()}:${geohashKey(lat1, lon1)}|${geohashKey(lat2, lon2)}`;
  }

  get(lat1: number, lon1: number, lat2: number, lon2: number): number {
    if (geohashKey(lat1, lon1) === geohashKey(lat2, lon2)) return 0;
    // Never trust a previously cached analytical (straight-line) estimate in
    // an operational context. Another request may have warmed this cache.
    if (requiresRoadData()) {
      const road = getCachedOsrmDistance(lat1, lon1, lat2, lon2);
      if (!road) throw new RoadDataUnavailableError();
      return road.distanceKm;
    }
    const k = this.key(lat1, lon1, lat2, lon2);
    const cached = this.distCache.get(k);
    if (cached !== undefined) return cached;

    const osrm = getCachedOsrmDistance(lat1, lon1, lat2, lon2);
    if (osrm) {
      this.distCache.set(k, osrm.distanceKm);
      this.durCache.set(k, osrm.durationMin);
      // Road matrices are directional. Never populate B→A from A→B:
      // one-way roads and access restrictions can change distance and time.
      return osrm.distanceKm;
    }

    const dist = haversineDistance(lat1, lon1, lat2, lon2);
    this.distCache.set(k, dist);
    this.distCache.set(this.key(lat2, lon2, lat1, lon1), dist);
    return dist;
  }

  getDuration(lat1: number, lon1: number, lat2: number, lon2: number): number | undefined {
    if (geohashKey(lat1, lon1) === geohashKey(lat2, lon2)) return 0;
    if (requiresRoadData()) {
      const road = getCachedOsrmDistance(lat1, lon1, lat2, lon2);
      if (!road) throw new RoadDataUnavailableError();
      return road.durationMin;
    }
    const k = this.key(lat1, lon1, lat2, lon2);
    const cached = this.durCache.get(k);
    if (cached !== undefined) return cached;

    const osrm = getCachedOsrmDistance(lat1, lon1, lat2, lon2);
    if (osrm) {
      this.distCache.set(k, osrm.distanceKm);
      this.durCache.set(k, osrm.durationMin);
      return osrm.durationMin;
    }
    return undefined;
  }

  invalidate(lat: number, lon: number): void {
    const gh = geohashKey(lat, lon);
    for (const k of this.distCache.keys()) {
      if (k.includes(":" + gh + "|") || k.endsWith("|" + gh)) {
        this.distCache.delete(k);
        this.durCache.delete(k);
      }
    }
  }

  clear(): void {
    this.distCache.clear();
    this.durCache.clear();
  }

  get size(): number {
    return this.distCache.size;
  }
}

export const globalDistanceCache = new DistanceMatrixCache();

export function getDistanceCache(): DistanceMatrixCache {
  return globalDistanceCache;
}

export function haversineDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLon = ((lon2 - lon1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

export function cachedDistance(lat1: number, lon1: number, lat2: number, lon2: number): number {
  return globalDistanceCache.get(lat1, lon1, lat2, lon2);
}

export function cachedDuration(lat1: number, lon1: number, lat2: number, lon2: number): number | undefined {
  return globalDistanceCache.getDuration(lat1, lon1, lat2, lon2);
}

export function estimateDuration(distanceKm: number, departureTime?: Date, lat1?: number, lon1?: number, lat2?: number, lon2?: number): number {
  const envCtx = getEnvCtx();
  let baseDuration: number;

  if (lat1 != null && lon1 != null && lat2 != null && lon2 != null) {
    const osrmDur = cachedDuration(lat1, lon1, lat2, lon2);
    if (osrmDur !== undefined) {
      baseDuration = osrmDur;
    } else if (departureTime) {
      baseDuration = estimateDurationMinPredictive(distanceKm, departureTime);
    } else {
      baseDuration = (distanceKm / 35) * 60;
    }

    const trafficMult = getSegmentTrafficMultiplier(lat1, lon1, lat2, lon2, departureTime);
    return baseDuration * Math.max(trafficMult, envCtx.weatherImpact);
  }

  if (departureTime) {
    baseDuration = estimateDurationMinPredictive(distanceKm, departureTime);
  } else {
    baseDuration = (distanceKm / 35) * 60;
  }

  return baseDuration * envCtx.weatherImpact;
}

export function estimateCo2(distanceKm: number, vehicleType: string, loadKg = 0, capacityKg = 1000): number {
  const profile = EMISSION_PROFILES[vehicleType] ?? EMISSION_PROFILES.fossil;
  const loadRatio = capacityKg > 0 ? Math.min(loadKg / capacityKg, 1) : 0;
  const loadAdjustment = 1 + loadRatio * (profile.loadFactor - 1);
  return (distanceKm * profile.gCo2PerKm * loadAdjustment) / 1000;
}
