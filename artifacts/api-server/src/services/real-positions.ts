import { db, vehiclePositionsTable } from "@workspace/db";
import { and, desc, eq } from "drizzle-orm";

export interface RealPosition {
  vehicleId: string;
  latitude: number;
  longitude: number;
  heading: number;
  speedKmh: number;
  timestamp: number;
}

const store = new Map<string, RealPosition>();
const STALE_THRESHOLD_MS = 30_000;

const PERSIST_INTERVAL_MS = 5_000;
const lastPersisted = new Map<string, number>();

interface PersistContext {
  organizationId?: string | null;
  routeId?: string | null;
  executionId?: string | null;
  startClientEventId?: string | null;
  accuracy?: number | null;
}

export function setRealPosition(vehicleId: string, pos: Omit<RealPosition, "vehicleId">): boolean {
  const previous = store.get(vehicleId);
  // Offline retries can arrive out of order. Never let an older fix replace a
  // newer in-memory fix or become the value served to the live map.
  if (previous && pos.timestamp < previous.timestamp) return false;
  store.set(vehicleId, { vehicleId, ...pos });
  return true;
}

export async function persistPosition(
  vehicleId: string,
  pos: Omit<RealPosition, "vehicleId">,
  ctx: PersistContext = {},
  database: Pick<typeof db, "insert"> = db,
): Promise<boolean> {
  if (!setRealPosition(vehicleId, pos)) return false;
  const persistenceKey = `${vehicleId}:${ctx.executionId ?? ""}:${ctx.startClientEventId ?? ""}`;
  const last = lastPersisted.get(persistenceKey) || 0;
  if (pos.timestamp - last < PERSIST_INTERVAL_MS) return true;

  if (!ctx.organizationId) return true;

  await database.insert(vehiclePositionsTable).values({
    organizationId: ctx.organizationId,
    vehicleId,
    routeId: ctx.routeId ?? null,
    executionId: ctx.executionId ?? null,
    startClientEventId: ctx.startClientEventId ?? null,
    latitude: pos.latitude,
    longitude: pos.longitude,
    heading: pos.heading,
    speedKmh: pos.speedKmh,
    accuracy: ctx.accuracy ?? null,
    source: "driver_app",
    recordedAt: new Date(pos.timestamp),
  });
  lastPersisted.set(persistenceKey, pos.timestamp);
  return true;
}

export function getRealPosition(vehicleId: string): RealPosition | null {
  const pos = store.get(vehicleId);
  if (!pos) return null;
  if (Date.now() - pos.timestamp > STALE_THRESHOLD_MS) return null;
  return pos;
}

/** Read evidence, not freshness: stale fixes remain visibly stale, never "now". */
export async function getLatestPositionEvidence(organizationId: string, vehicleId: string): Promise<RealPosition | null> {
  const cached = store.get(vehicleId);
  const [persisted] = await db.select().from(vehiclePositionsTable).where(and(
    eq(vehiclePositionsTable.organizationId, organizationId), eq(vehiclePositionsTable.vehicleId, vehicleId),
  )).orderBy(desc(vehiclePositionsTable.recordedAt)).limit(1);
  if (!persisted || (cached && cached.timestamp >= persisted.recordedAt.getTime())) return cached ?? null;
  return { vehicleId, latitude: persisted.latitude, longitude: persisted.longitude,
    heading: persisted.heading ?? 0, speedKmh: persisted.speedKmh ?? 0, timestamp: persisted.recordedAt.getTime() };
}

export function getAllRealPositions(): RealPosition[] {
  const now = Date.now();
  const result: RealPosition[] = [];
  for (const pos of store.values()) {
    if (now - pos.timestamp <= STALE_THRESHOLD_MS) {
      result.push(pos);
    }
  }
  return result;
}
