import { serialize, deserialize } from "node:v8";
import { and, eq, gt, lt } from "drizzle-orm";
import { sql } from "drizzle-orm";
import { db, planningRuntimeStateTable } from "@workspace/db";

// v8 preserves Date, Map, Set and undefined in optimizer proposals. JSON would
// silently alter the executable proposal and its feasibility semantics.
export function encodeRuntimeState(value: unknown): string {
  return serialize(value).toString("base64");
}

export function decodeRuntimeState<T>(payload: string): T {
  return deserialize(Buffer.from(payload, "base64")) as T;
}

function stateKey(organizationId: string, kind: string, id: string): string {
  return JSON.stringify([organizationId, kind, id]);
}

export async function saveRuntimeState(
  organizationId: string, kind: string, id: string, value: unknown, ttlMs: number,
  executor: Pick<typeof db, "insert"> = db,
): Promise<void> {
  const now = new Date();
  await executor.insert(planningRuntimeStateTable).values({
    key: stateKey(organizationId, kind, id), organizationId, kind,
    payload: encodeRuntimeState(value), updatedAt: now,
    expiresAt: new Date(now.getTime() + ttlMs),
  }).onConflictDoUpdate({
    target: planningRuntimeStateTable.key,
    set: { payload: encodeRuntimeState(value), updatedAt: now, expiresAt: new Date(now.getTime() + ttlMs) },
  });
}

export async function loadRuntimeState<T>(
  organizationId: string, kind: string, id: string,
): Promise<{ value: T; updatedAt: Date } | null> {
  const [row] = await db.select().from(planningRuntimeStateTable).where(and(
    eq(planningRuntimeStateTable.key, stateKey(organizationId, kind, id)),
    eq(planningRuntimeStateTable.organizationId, organizationId),
    eq(planningRuntimeStateTable.kind, kind),
    gt(planningRuntimeStateTable.expiresAt, new Date()),
  ));
  return row ? { value: decodeRuntimeState<T>(row.payload), updatedAt: row.updatedAt } : null;
}

export async function deleteRuntimeState(organizationId: string, kind: string, id: string): Promise<void> {
  await db.delete(planningRuntimeStateTable).where(and(
    eq(planningRuntimeStateTable.key, stateKey(organizationId, kind, id)),
    eq(planningRuntimeStateTable.organizationId, organizationId),
    eq(planningRuntimeStateTable.kind, kind),
  ));
}

export async function purgeExpiredRuntimeState(): Promise<void> {
  await db.delete(planningRuntimeStateTable).where(lt(planningRuntimeStateTable.expiresAt, new Date()));
}

export async function retainRuntimeState<T>(
  organizationId: string, kind: string, id: string, candidate: T,
  ttlMs: number, choose: (previous: T, candidate: T) => T,
): Promise<T> {
  const key = stateKey(organizationId, kind, id);
  return db.transaction(async tx => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${key}))`);
    const [row] = await tx.select().from(planningRuntimeStateTable).where(and(
      eq(planningRuntimeStateTable.key, key),
      eq(planningRuntimeStateTable.organizationId, organizationId),
      gt(planningRuntimeStateTable.expiresAt, new Date()),
    ));
    const selected = row ? choose(decodeRuntimeState<T>(row.payload), candidate) : candidate;
    const now = new Date();
    await tx.insert(planningRuntimeStateTable).values({
      key, organizationId, kind, payload: encodeRuntimeState(selected),
      updatedAt: now, expiresAt: new Date(now.getTime() + ttlMs),
    }).onConflictDoUpdate({
      target: planningRuntimeStateTable.key,
      set: { payload: encodeRuntimeState(selected), updatedAt: now, expiresAt: new Date(now.getTime() + ttlMs) },
    });
    return selected;
  });
}
