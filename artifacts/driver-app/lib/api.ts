import { Platform } from "react-native";

const ORG_ID = "63e7175d-af1d-4dc3-be62-842a8b3dc9f8";

function getBaseUrl(): string {
  const domain = process.env.EXPO_PUBLIC_DOMAIN;
  if (domain) {
    return `https://${domain}/api`;
  }
  if (Platform.OS === "web") {
    return "/api";
  }
  return "http://localhost:8080/api";
}

const BASE_URL = getBaseUrl();

async function request<T>(
  path: string,
  options?: RequestInit,
): Promise<T> {
  const url = `${BASE_URL}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...options?.headers,
    },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`API ${res.status}: ${body}`);
  }
  return res.json();
}

export interface Driver {
  id: string;
  name: string;
  phone: string | null;
  email: string | null;
  organizationId: string;
  vehicleId: string | null;
}

export interface Vehicle {
  id: string;
  name: string;
  licensePlate: string | null;
  type: string | null;
  capacityKg: number | null;
  capacityM3: number | null;
  organizationId: string;
}

export interface Route {
  id: string;
  name: string;
  status: string;
  driverId: string | null;
  vehicleId: string | null;
  organizationId: string;
  date: string | null;
  optimizedAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  totalDistanceKm: number | null;
  totalDurationMin: number | null;
  totalCo2Kg: number | null;
}

export interface Stop {
  id: string;
  routeId: string;
  address: string;
  latitude: number | null;
  longitude: number | null;
  status: string;
  sequence: number | null;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  serviceDurationMin: number | null;
  notes: string | null;
  contactName: string | null;
  contactEmail: string | null;
  completedAt: string | null;
}

export interface DriverPreferences {
  id: string;
  driverId: string;
  preferredStartTime: string | null;
  preferredEndTime: string | null;
  maxDrivingHours: number | null;
  avoidNightDriving: boolean;
}

export interface DriverStats {
  totalRoutes: number;
  completedRoutes: number;
  totalDeliveries: number;
  completedDeliveries: number;
  failedDeliveries: number;
  skippedDeliveries: number;
  onTimeRate: number | null;
  avgServiceDurationMin: number | null;
  totalDistanceKm: number | null;
  happinessScore: number | null;
}

export const api = {
  getDrivers: () =>
    request<Driver[]>(`/drivers?organizationId=${ORG_ID}`),

  getDriver: (id: string) =>
    request<Driver>(`/drivers/${id}?organizationId=${ORG_ID}`),

  getRoutes: (driverId?: string) => {
    let url = `/routes?organizationId=${ORG_ID}`;
    if (driverId) url += `&driverId=${driverId}`;
    return request<Route[]>(url);
  },

  getRoute: (id: string) =>
    request<Route>(`/routes/${id}?organizationId=${ORG_ID}`),

  getRouteStops: (routeId: string) =>
    request<Stop[]>(`/routes/${routeId}/stops?organizationId=${ORG_ID}`),

  updateStop: (id: string, data: Partial<Stop>) =>
    request<Stop>(`/stops/${id}?organizationId=${ORG_ID}`, {
      method: "PUT",
      body: JSON.stringify({ ...data, organizationId: ORG_ID }),
    }),

  getDriverPreferences: (driverId: string) =>
    request<DriverPreferences>(`/drivers/${driverId}/preferences?organizationId=${ORG_ID}`),

  updateDriverPreferences: (driverId: string, data: Partial<DriverPreferences>) =>
    request<DriverPreferences>(`/drivers/${driverId}/preferences?organizationId=${ORG_ID}`, {
      method: "PUT",
      body: JSON.stringify({ ...data, organizationId: ORG_ID }),
    }),

  getDriverStats: (driverId: string) =>
    request<DriverStats>(`/drivers/${driverId}/stats?organizationId=${ORG_ID}`),

  submitProof: (stopId: string, data: { proofType: string; data: string; notes?: string }) =>
    request<unknown>(`/stops/${stopId}/proof?organizationId=${ORG_ID}`, {
      method: "POST",
      body: JSON.stringify({ ...data, organizationId: ORG_ID }),
    }),

  getStopProofs: (stopId: string) =>
    request<unknown[]>(`/stops/${stopId}/proofs?organizationId=${ORG_ID}`),

  getVehicles: () =>
    request<Vehicle[]>(`/vehicles?organizationId=${ORG_ID}`),

  getVehicle: (id: string) =>
    request<Vehicle>(`/vehicles/${id}?organizationId=${ORG_ID}`),
};

function decodePolyline(encoded: string): [number, number][] {
  const points: [number, number][] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;

  while (index < encoded.length) {
    let shift = 0;
    let result = 0;
    let byte: number;

    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lat += result & 1 ? ~(result >> 1) : result >> 1;

    shift = 0;
    result = 0;
    do {
      byte = encoded.charCodeAt(index++) - 63;
      result |= (byte & 0x1f) << shift;
      shift += 5;
    } while (byte >= 0x20);
    lng += result & 1 ? ~(result >> 1) : result >> 1;

    points.push([lat / 1e5, lng / 1e5]);
  }

  return points;
}

const routeGeometryCache = new Map<string, { latitude: number; longitude: number }[]>();

export async function fetchRouteGeometry(
  waypoints: { latitude: number; longitude: number }[],
): Promise<{ latitude: number; longitude: number }[]> {
  if (waypoints.length < 2) return waypoints;

  const key = waypoints.map((w) => `${w.latitude.toFixed(5)},${w.longitude.toFixed(5)}`).join("|");
  if (routeGeometryCache.has(key)) return routeGeometryCache.get(key)!;

  const coords = waypoints.map((w) => `${w.longitude},${w.latitude}`).join(";");
  const url = `${BASE_URL}/osrm/route?coords=${encodeURIComponent(coords)}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return waypoints;
    const data = await res.json();
    if (data.code !== "Ok" || !data.routes?.[0]) return waypoints;
    const decoded = decodePolyline(data.routes[0].geometry);
    const result = decoded.map(([lat, lng]) => ({ latitude: lat, longitude: lng }));
    routeGeometryCache.set(key, result);
    return result;
  } catch {
    return waypoints;
  }
}
