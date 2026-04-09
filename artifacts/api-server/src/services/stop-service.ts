import { eq, and } from "drizzle-orm";
import { db, stopsTable, notificationsTable, vehiclesTable, routesTable } from "@workspace/db";
import { getDistanceCache } from "./alns";
import { sendFailedNotification } from "./email";
import { dispatchWebhookEvent } from "./webhooks";
import { broadcastDataChange } from "./realtime";

export async function listStops(organizationId: string, routeId?: string) {
  const conditions = [eq(stopsTable.organizationId, organizationId)];
  if (routeId) {
    conditions.push(eq(stopsTable.routeId, routeId));
  }
  return db.select().from(stopsTable).where(and(...conditions));
}

export async function getStop(id: string, organizationId: string) {
  const [stop] = await db
    .select()
    .from(stopsTable)
    .where(and(eq(stopsTable.id, id), eq(stopsTable.organizationId, organizationId)));
  return stop ?? null;
}

export async function createStop(data: Record<string, unknown>) {
  const [stop] = await db.insert(stopsTable).values(data as any).returning();
  getDistanceCache().invalidate(stop.latitude, stop.longitude);
  broadcastDataChange(stop.organizationId, "stop", "created", { id: stop.id, address: stop.address });
  return stop;
}

export async function importStops(organizationId: string, stopRows: any[]) {
  const values = stopRows.map((row: any) => ({
    organizationId,
    address: row.address,
    latitude: row.latitude,
    longitude: row.longitude,
    timeWindowStart: row.timeWindowStart ? new Date(row.timeWindowStart) : null,
    timeWindowEnd: row.timeWindowEnd ? new Date(row.timeWindowEnd) : null,
    serviceDurationMin: row.serviceDurationMin ?? 15,
    notes: row.notes ?? null,
    weightKg: row.weightKg ?? null,
    volumeM3: row.volumeM3 ?? null,
    contactName: row.contactName ?? null,
    contactEmail: row.contactEmail ?? null,
  }));
  const created = await db.transaction(async (tx) => {
    return tx.insert(stopsTable).values(values).returning();
  });
  const cache = getDistanceCache();
  for (const s of created) {
    cache.invalidate(s.latitude, s.longitude);
  }
  broadcastDataChange(organizationId, "stop", "created", { bulk: true, count: created.length });
  return created;
}

export async function updateStop(id: string, organizationId: string, data: Record<string, unknown>, contactFields: Record<string, string | null> = {}) {
  const conditions = [eq(stopsTable.id, id), eq(stopsTable.organizationId, organizationId)];

  const [existing] = await db.select().from(stopsTable).where(and(...conditions));

  const [stop] = await db
    .update(stopsTable)
    .set({ ...data, ...contactFields } as any)
    .where(and(...conditions))
    .returning();
  if (!stop) return null;

  if (existing && (existing.latitude !== stop.latitude || existing.longitude !== stop.longitude)) {
    getDistanceCache().invalidate(existing.latitude, existing.longitude);
    getDistanceCache().invalidate(stop.latitude, stop.longitude);
  }

  if (existing && existing.status !== "failed" && stop.status === "failed") {
    let vehicleName = "Vehicle";
    if (stop.routeId) {
      const [route] = await db.select().from(routesTable).where(eq(routesTable.id, stop.routeId));
      if (route?.vehicleId) {
        const [vehicle] = await db.select().from(vehiclesTable).where(eq(vehiclesTable.id, route.vehicleId));
        if (vehicle) vehicleName = vehicle.name;
      }
    }
    await db.insert(notificationsTable).values({
      organizationId: stop.organizationId,
      type: "stop_failed",
      title: `Delivery failed`,
      message: `${vehicleName} failed delivery at ${stop.address}`,
      relatedEntityId: stop.id,
    });

    if (stop.routeId) {
      const [failRoute] = await db.select().from(routesTable).where(eq(routesTable.id, stop.routeId));
      if (failRoute?.notifyFailed) {
        sendFailedNotification(stop.id, stop.routeId, vehicleName).catch((err) =>
          console.error("[EMAIL] Failed to send failed notification:", err)
        );
      }
    }
  }

  if (existing && existing.status !== stop.status) {
    const eventMap: Record<string, string> = { completed: "stop.completed", failed: "stop.failed", skipped: "stop.skipped" };
    const event = eventMap[stop.status];
    if (event) {
      dispatchWebhookEvent(stop.organizationId, event, {
        stopId: stop.id, address: stop.address, status: stop.status, routeId: stop.routeId,
      }).catch(() => {});
    }
  }

  broadcastDataChange(stop.organizationId, "stop", "updated", { id: stop.id, address: stop.address, status: stop.status });
  return stop;
}

export async function deleteStop(id: string, organizationId: string) {
  const [deleted] = await db
    .delete(stopsTable)
    .where(and(eq(stopsTable.id, id), eq(stopsTable.organizationId, organizationId)))
    .returning();
  if (deleted) {
    getDistanceCache().invalidate(deleted.latitude, deleted.longitude);
    broadcastDataChange(organizationId, "stop", "deleted", { id });
  }
  return deleted ?? null;
}
