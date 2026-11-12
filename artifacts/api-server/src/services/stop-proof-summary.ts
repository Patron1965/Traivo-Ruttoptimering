import { and, eq, inArray } from "drizzle-orm";
import { db, deliveryProofsTable, stopsTable } from "@workspace/db";

/** Metadata only, tenant-bound and batched. Never exposes proof data or URLs. */
export async function withStopProofTypes<T extends { id: string }>(
  stops: T[], organizationId: string, role?: string,
): Promise<Array<T & { proofTypes: string[] }>> {
  if (role === "viewer" || stops.length === 0) return stops.map(stop => ({ ...stop, proofTypes: [] }));
  const types = new Map<string, Set<string>>();
  for (let offset = 0; offset < stops.length; offset += 2000) {
    const rows = await db.selectDistinct({ stopId: deliveryProofsTable.stopId, type: deliveryProofsTable.proofType })
      .from(deliveryProofsTable).innerJoin(stopsTable, eq(stopsTable.id, deliveryProofsTable.stopId))
      .where(and(eq(stopsTable.organizationId, organizationId),
        inArray(stopsTable.id, stops.slice(offset, offset + 2000).map(stop => stop.id))));
    for (const row of rows) {
      if (!["photo", "signature", "barcode"].includes(row.type)) continue;
      const values = types.get(row.stopId) ?? new Set<string>();
      values.add(row.type); types.set(row.stopId, values);
    }
  }
  return stops.map(stop => ({ ...stop, proofTypes: [...(types.get(stop.id) ?? [])].sort() }));
}
