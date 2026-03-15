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
  driverId: string;
  totalRoutes: number;
  totalStops: number;
  completedStops: number;
  failedStops: number;
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
};
