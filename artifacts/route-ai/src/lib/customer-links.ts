export interface CustomerLink {
  status: "none" | "active" | "expired" | "revoked" | "unavailable";
  url: string | null;
  expiresAt: string | null;
  configurationReady: boolean;
}
export type CustomerLinkAction = "create" | "replace" | "revoke";
export function destinationCoordinates(latitude: number | null, longitude: number | null): [number, number] | null {
  return typeof latitude === "number" && typeof longitude === "number"
    && Number.isFinite(latitude) && Number.isFinite(longitude)
    && Math.abs(latitude) <= 90 && Math.abs(longitude) <= 180
    ? [latitude, longitude] : null;
}
export interface PublicDelivery {
  status: "scheduled" | "on_the_way" | "arriving_soon" | "delivered" | "failed";
  address: string;
  latitude: number | null;
  longitude: number | null;
  timeWindowStart: string | null;
  timeWindowEnd: string | null;
  brand: null;
  tracking?: {
    state: "live" | "stale" | "waiting" | "inactive" | "completed" | "unavailable";
    position: { latitude: number; longitude: number } | null;
    lastUpdatedAt: string | null;
    freshUntil: string | null;
    reason: "not_next" | "execution_inactive" | "gps_missing" | "gps_stale" | "plan_changed" | "service_pause" | null;
  };
  arrival?: {
    plannedAt: string | null;
    estimatedAt: string | null;
    source: "road" | null;
    calculatedAt: string | null;
    reason: "not_live" | "road_unavailable" | "service_pause" | null;
  };
}
export function publicTrackingPolicy(data: PublicDelivery | null, now: number, online = true) {
  const tracking = data?.tracking;
  const timestamp = (value: string | null | undefined) => value ? Date.parse(value) : NaN;
  const updated = timestamp(tracking?.lastUpdatedAt);
  const freshUntil = timestamp(tracking?.freshUntil);
  const deadline = Math.min(freshUntil, updated + 120_000);
  const lastUpdatedAt = Number.isFinite(updated) && updated <= now ? tracking?.lastUpdatedAt ?? null : null;
  const coordinates = tracking?.position ? destinationCoordinates(tracking.position.latitude, tracking.position.longitude) : null;
  let state: string = "unavailable";
  if (!online) state = "offline";
  else if (data?.status === "delivered" || data?.status === "failed" || tracking?.state === "completed") state = "completed";
  else if (tracking && ["live", "stale", "waiting", "inactive", "unavailable"].includes(tracking.state)) {
    state = tracking.state;
    if (tracking.state === "live") {
      state = !coordinates || !lastUpdatedAt || !Number.isFinite(deadline) ? "missing" : now >= deadline ? "stale" : "live";
    }
    if (tracking.reason === "not_next") state = "not_next";
    else if (tracking.reason === "execution_inactive" || tracking.reason === "plan_changed" || tracking.reason === "service_pause") state = "inactive";
    else if (tracking.reason === "gps_missing") state = "missing";
    else if (tracking.reason === "gps_stale") state = "stale";
  }
  const calculated = timestamp(data?.arrival?.calculatedAt);
  const estimated = timestamp(data?.arrival?.estimatedAt);
  const estimatedAt = state === "live" && data?.arrival?.source === "road" && data.arrival.reason === null
    && Number.isFinite(calculated) && calculated <= now && now - calculated < 120_000
    && Number.isFinite(estimated) && estimated >= now ? data.arrival.estimatedAt : null;
  return {
    state, position: state === "live" ? coordinates : null, lastUpdatedAt,
    estimatedAt, deadline: state === "live" ? Math.min(deadline, estimatedAt ? calculated + 120_000 : deadline, estimatedAt ? estimated + 1 : deadline) : null,
  };
}
export class CustomerLinkError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string) {
    super("Customer link request failed");
    this.status = status;
    this.code = code;
  }
}
export async function requestCustomerLink(
  base: string, stopId: string, action?: CustomerLinkAction, signal?: AbortSignal,
): Promise<CustomerLink> {
  const response = await fetch(`${base}/api/stops/${encodeURIComponent(stopId)}/customer-link`, {
    method: action ? "POST" : "GET",
    credentials: "include", cache: "no-store", referrerPolicy: "no-referrer", signal,
    ...(action ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action }) } : {}),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => ({}));
    throw new CustomerLinkError(response.status, typeof body.code === "string" ? body.code : "REQUEST_FAILED");
  }
  return response.json();
}
export function shareableUrl(link: CustomerLink | undefined): string | null {
  if (!link || link.status !== "active" || !link.url || !link.expiresAt || !Number.isFinite(Date.parse(link.expiresAt)) || Date.parse(link.expiresAt) <= Date.now()) return null;
  try {
    const url = new URL(link.url);
    return url.protocol === "https:" && !url.username && !url.password ? link.url : null;
  } catch { return null; }
}