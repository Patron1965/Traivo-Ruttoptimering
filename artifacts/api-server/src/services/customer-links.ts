import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { db, customerLinksTable, stopsTable, routesTable } from "@workspace/db";
import { liveSnapshot, roadArrival, directionalRoad, type RoadAdapter } from "./customer-live-tracking";
import { outgoingStopContext } from "./outgoing-route-service";

export type CustomerLinkState = {
  status: "none" | "active" | "expired" | "revoked" | "unavailable";
  url: string | null;
  expiresAt: string | null;
  configurationReady: boolean;
};
export class CustomerLinkError extends Error {
  constructor(public code: string, public httpStatus: number, message: string) { super(message); }
}
export const DAY_MS = 86_400_000;
export function trackingBaseUrl(): string | null {
  try {
    const url = new URL(process.env.PUBLIC_TRACKING_BASE_URL ?? "");
    const host = url.hostname.toLowerCase();
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash ||
        url.port || host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") ||
        host.endsWith(".replit.dev") || host.endsWith(".repl.co") ||
        !host.includes(".") || /^[\d.]+$/.test(host) || host.includes(":")) return null;
    return url.href.replace(/\/+$/, "");
  } catch { return null; }
}
function secret(): string | null {
  const value = process.env.SESSION_SECRET;
  return value && value.length >= 32 ? value : null;
}
function tokenFor(stopId: string, salt: string): string | null {
  const key = secret();
  return key ? createHmac("sha256", key).update(`customer-link:v1:${stopId}:${salt}`).digest("base64url") : null;
}
export function tokenHash(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}
type Stop = typeof stopsTable.$inferSelect;
type Link = typeof customerLinksTable.$inferSelect;
export function effectiveExpiry(stop: Pick<Stop, "status" | "terminalAt">, link: Pick<Link, "expiresAt">): Date {
  if (["completed", "failed", "skipped"].includes(stop.status)) {
    // Historical terminal work without a trustworthy timestamp fails closed.
    return new Date(Math.min(link.expiresAt.getTime(), stop.terminalAt ? stop.terminalAt.getTime() + DAY_MS : 0));
  }
  return link.expiresAt;
}
export function customerLinkState(stop: Stop, link: Link | undefined, now: Date): CustomerLinkState {
  const base = trackingBaseUrl();
  const configurationReady = Boolean(base && secret());
  const result: CustomerLinkState = { status: "none", url: null, expiresAt: null, configurationReady };
  if (!link) return stop.archivedAt ? { ...result, status: "unavailable" } : result;
  result.expiresAt = effectiveExpiry(stop, link).toISOString();
  if (link.revokedAt) return { ...result, status: "revoked" };
  if (stop.archivedAt || stop.routeId !== link.routeId) return { ...result, status: "unavailable" };
  if (Date.parse(result.expiresAt) <= now.getTime()) return { ...result, status: "expired" };
  const token = tokenFor(stop.id, link.salt);
  if (!configurationReady || !token || !timingSafeEqual(Buffer.from(tokenHash(token)), Buffer.from(link.tokenHash))) {
    return { ...result, status: "unavailable" };
  }
  return { ...result, status: "active", url: `${base}/track/${token}` };
}
const state = customerLinkState;

// Every management operation, including reads, uses the stop lock. Revocation,
// replacement and lifecycle writers are serialized on the same row.
export async function manageCustomerLink(stopId: string, organizationId: string, action?: "create" | "replace" | "revoke"): Promise<CustomerLinkState> {
  return db.transaction(async (tx) => {
    const [stop] = await tx.select().from(stopsTable)
      .where(and(eq(stopsTable.id, stopId), eq(stopsTable.organizationId, organizationId))).for("update");
    if (!stop) throw new CustomerLinkError("STOP_NOT_FOUND", 404, "Leveransen finns inte.");
    let [link] = await tx.select().from(customerLinksTable).where(eq(customerLinksTable.stopId, stopId));
    const now = new Date();
    if (action === "revoke") {
      // A tombstone also prevents later automatic creation for previously unlinked stops.
      if (!link) {
        [link] = await tx.insert(customerLinksTable).values({
          stopId, routeId: stop.routeId, salt: randomBytes(32).toString("hex"),
          tokenHash: tokenHash(randomBytes(32).toString("hex")), createdAt: now, expiresAt: now, revokedAt: now,
        }).returning();
      } else {
        [link] = await tx.update(customerLinksTable).set({ revokedAt: link.revokedAt ?? now })
          .where(eq(customerLinksTable.stopId, stopId)).returning();
      }
    } else if (action) {
      const current = state(stop, link, now);
      if (!current.configurationReady) throw new CustomerLinkError("TRACKING_NOT_CONFIGURED", 503, "Kundlänkar är inte konfigurerade.");
      if (stop.archivedAt) throw new CustomerLinkError("STOP_UNAVAILABLE", 409, "Leveransen är inte tillgänglig.");
      if (action === "create" && link) {
        if (current.status === "active") return current;
        throw new CustomerLinkError("LINK_REPLACEMENT_REQUIRED", 409, "Ersätt den tidigare kundlänken uttryckligen.");
      }
      const currentTerminalDeadline = ["completed", "failed", "skipped"].includes(stop.status)
        ? new Date(stop.terminalAt ? stop.terminalAt.getTime() + DAY_MS : 0) : null;
      const terminalExpiresAt = link?.terminalExpiresAt && currentTerminalDeadline
        ? new Date(Math.min(link.terminalExpiresAt.getTime(), currentTerminalDeadline.getTime()))
        : link?.terminalExpiresAt ?? currentTerminalDeadline;
      const expiresAt = effectiveExpiry(stop, {
        expiresAt: new Date(Math.min(now.getTime() + 7 * DAY_MS, terminalExpiresAt?.getTime() ?? Infinity)),
      });
      if (expiresAt <= now) throw new CustomerLinkError("STOP_EXPIRED", 409, "Leveransens delningsperiod är slut.");
      const salt = randomBytes(32).toString("hex");
      const values = { stopId, routeId: stop.routeId, salt, tokenHash: tokenHash(tokenFor(stopId, salt)!), createdAt: now, expiresAt, terminalExpiresAt, revokedAt: null };
      [link] = await tx.insert(customerLinksTable).values(values)
        .onConflictDoUpdate({ target: customerLinksTable.stopId, set: values }).returning();
    }
    return state(stop, link, now);
  });
}

// Notification paths may reuse only, never mint, replace, extend or un-revoke.
export async function existingCustomerTrackingUrl(stopId: string, organizationId: string): Promise<string | null> {
  return (await manageCustomerLink(stopId, organizationId)).url;
}

async function publicCustomerSnapshot(token: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const [row] = await db.select({ stop: stopsTable, link: customerLinksTable }).from(customerLinksTable)
    .innerJoin(stopsTable, eq(stopsTable.id, customerLinksTable.stopId))
    .where(eq(customerLinksTable.tokenHash, tokenHash(token)));
  if (!row) return null;
  const { organizationAllowsAccess } = await import("../lib/session");
  if (!await organizationAllowsAccess(row.stop.organizationId)) return null;
  if (row.link.routeId) {
    const [route] = await db.select().from(routesTable)
      .where(and(eq(routesTable.id, row.link.routeId), eq(routesTable.organizationId, row.stop.organizationId)));
    if (!route) return null;
    if (route.handoffVersion != null) {
      try {
        const context = await outgoingStopContext(row.stop.organizationId, row.stop.id, null, db, row.link.routeId);
        row.stop = context.stop;
      } catch { return null; }
    }
  }
  if (state(row.stop, row.link, new Date()).status !== "active") return null;
  const stop = row.stop;
  return { stop, delivery: {
    status: stop.status === "completed" ? "delivered" as const :
      stop.status === "failed" || stop.status === "skipped" ? "failed" as const :
      stop.status === "in_progress" ? "on_the_way" as const : "scheduled" as const,
    address: stop.address,
    latitude: Number.isFinite(stop.latitude) ? stop.latitude : null,
    longitude: Number.isFinite(stop.longitude) ? stop.longitude : null,
    timeWindowStart: stop.timeWindowStart?.toISOString() ?? null,
    timeWindowEnd: stop.timeWindowEnd?.toISOString() ?? null,
    brand: null,
  } };
}

export async function readPublicCustomerLink(token: string, roadAdapter: RoadAdapter = directionalRoad) {
  const first = await publicCustomerSnapshot(token);
  if (!first) return null;
  const snapshot = await liveSnapshot(first.stop);
  const arrival = await roadArrival(snapshot, first.stop, roadAdapter);
  // Revalidate the bearer link AND every eligibility input after network I/O.
  const current = await publicCustomerSnapshot(token);
  if (!current) return null;
  const fresh = await liveSnapshot(current.stop);
  const finalLink = await publicCustomerSnapshot(token);
  if (!finalLink || JSON.stringify(finalLink.stop) !== JSON.stringify(current.stop)) return null;
  return { ...current.delivery, tracking: fresh.tracking,
    arrival: fresh.key && fresh.key === snapshot.key && fresh.tracking.state === "live" ? arrival : fresh.arrival };
}