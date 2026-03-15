import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, stopsTable, notificationsTable, vehiclesTable, routesTable } from "@workspace/db";
import {
  CreateStopBody,
  UpdateStopBody,
  ListStopsQueryParams,
  ImportStopsBody,
} from "@workspace/api-zod";
import { handleError, parseUuidParam } from "../lib/errors";
import { getDistanceCache } from "../services/alns";
import { sendFailedNotification } from "../services/email";

const router: IRouter = Router();

router.get("/stops", async (req, res) => {
  try {
    const { organizationId, routeId } = ListStopsQueryParams.parse(req.query);
    const conditions = [eq(stopsTable.organizationId, organizationId)];
    if (routeId) {
      conditions.push(eq(stopsTable.routeId, routeId));
    }
    const stops = await db
      .select()
      .from(stopsTable)
      .where(and(...conditions));
    res.json(stops);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/stops/import", async (req, res) => {
  try {
    const data = ImportStopsBody.parse(req.body);
    const { organizationId, stops: stopRows } = data;
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
    res.status(201).json({ imported: created.length, stops: created });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/stops/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = req.query.organizationId as string | undefined;
    const conditions = [eq(stopsTable.id, id)];
    if (orgId) conditions.push(eq(stopsTable.organizationId, orgId));
    const [stop] = await db
      .select()
      .from(stopsTable)
      .where(and(...conditions));
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    res.json(stop);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/stops", async (req, res) => {
  try {
    const data = CreateStopBody.parse(req.body);
    const contactFields: Record<string, string> = {};
    if (typeof req.body.contactName === "string") contactFields.contactName = req.body.contactName;
    if (typeof req.body.contactEmail === "string") contactFields.contactEmail = req.body.contactEmail;
    const [stop] = await db.insert(stopsTable).values({ ...data, ...contactFields }).returning();
    getDistanceCache().invalidate(stop.latitude, stop.longitude);
    res.status(201).json(stop);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/stops/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const data = UpdateStopBody.parse(req.body);
    const contactFields: Record<string, string | null> = {};
    if (typeof req.body.contactName === "string" || req.body.contactName === null) contactFields.contactName = req.body.contactName;
    if (typeof req.body.contactEmail === "string" || req.body.contactEmail === null) contactFields.contactEmail = req.body.contactEmail;
    const orgId = req.query.organizationId as string | undefined;
    const conditions = [eq(stopsTable.id, id)];
    if (orgId) conditions.push(eq(stopsTable.organizationId, orgId));

    const [existing] = await db
      .select()
      .from(stopsTable)
      .where(and(...conditions));

    const [stop] = await db
      .update(stopsTable)
      .set({ ...data, ...contactFields })
      .where(and(...conditions))
      .returning();
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }

    if (existing && (existing.latitude !== stop.latitude || existing.longitude !== stop.longitude)) {
      getDistanceCache().invalidate(existing.latitude, existing.longitude);
      getDistanceCache().invalidate(stop.latitude, stop.longitude);
    }

    if (existing && existing.status !== "failed" && stop.status === "failed") {
      let vehicleName = "Vehicle";
      if (stop.routeId) {
        const [route] = await db
          .select()
          .from(routesTable)
          .where(eq(routesTable.id, stop.routeId));
        if (route?.vehicleId) {
          const [vehicle] = await db
            .select()
            .from(vehiclesTable)
            .where(eq(vehiclesTable.id, route.vehicleId));
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

    res.json(stop);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/stops/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = req.query.organizationId as string | undefined;
    const conditions = [eq(stopsTable.id, id)];
    if (orgId) conditions.push(eq(stopsTable.organizationId, orgId));
    const [deleted] = await db
      .delete(stopsTable)
      .where(and(...conditions))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    getDistanceCache().invalidate(deleted.latitude, deleted.longitude);
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
