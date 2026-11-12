import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, routeTemplatesTable, routesTable, stopsTable, vehiclesTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { assertOrgScope, getOrgId } from "../middleware/auth";
import { geocodeAddress } from "../services/geocoding";
import {
  applyVerifiedNavigationDestination,
  cleanNavigationVerification,
} from "../services/stop-service";

const router: IRouter = Router();

router.get("/route-templates", async (req, res) => {
  try {
    const organizationId = getOrgId(req);
    const templates = await db
      .select()
      .from(routeTemplatesTable)
      .where(eq(routeTemplatesTable.organizationId, organizationId));
    res.json(templates);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/route-templates", async (req, res) => {
  try {
    const { organizationId: requestedOrganizationId, name, description, stopData, vehicleType } = req.body;
    const organizationId = assertOrgScope(req, requestedOrganizationId);
    if (!name) {
      res.status(400).json({ error: "name is required" });
      return;
    }
    const safeStopData = Array.isArray(stopData)
      ? stopData.map((value) => {
          const safe = value && typeof value === "object"
            ? { ...value } as Record<string, unknown>
            : {};
          cleanNavigationVerification(safe);
          return safe;
        })
      : [];
    const [template] = await db
      .insert(routeTemplatesTable)
      .values({ organizationId, name, description, stopData: safeStopData, vehicleType })
      .returning();
    res.status(201).json(template);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/route-templates/from-route/:routeId", async (req, res) => {
  try {
    const routeId = req.params.routeId;
    const organizationId = getOrgId(req);
    const { name } = req.body;

    const [route] = await db
      .select()
      .from(routesTable)
      .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    const stops = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, routeId))
      .orderBy(stopsTable.sequenceOrder);

    const stopData = stops.map((s) => ({
      address: s.address,
      latitude: s.latitude,
      longitude: s.longitude,
      serviceDurationMin: s.serviceDurationMin,
      weightKg: s.weightKg,
      volumeM3: s.volumeM3,
      notes: s.notes,
      customFields: s.customFields,
      timeWindowStartOffset: s.timeWindowStart
        ? new Date(s.timeWindowStart).getHours() * 60 + new Date(s.timeWindowStart).getMinutes()
        : null,
      timeWindowEndOffset: s.timeWindowEnd
        ? new Date(s.timeWindowEnd).getHours() * 60 + new Date(s.timeWindowEnd).getMinutes()
        : null,
    }));

    const [template] = await db
      .insert(routeTemplatesTable)
      .values({
        organizationId,
        name: name || `${route.name} (mall)`,
        description: `Skapad från rutt: ${route.name}`,
        stopData,
      })
      .returning();

    res.status(201).json(template);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/route-templates/:id/apply", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = getOrgId(req);
    const { routeName, date, vehicleId } = req.body;

    const [template] = await db
      .select()
      .from(routeTemplatesTable)
      .where(and(eq(routeTemplatesTable.id, id), eq(routeTemplatesTable.organizationId, organizationId)));
    if (!template) {
      res.status(404).json({ error: "Template not found" });
      return;
    }

    if (vehicleId) {
      const [vehicle] = await db
        .select()
        .from(vehiclesTable)
        .where(and(eq(vehiclesTable.id, vehicleId), eq(vehiclesTable.organizationId, organizationId)));
      if (!vehicle) {
        res.status(400).json({ error: "Vehicle not found in this organization" });
        return;
      }
    }

    const stopData = template.stopData as Array<{
      address: string;
      latitude: number;
      longitude: number;
      serviceDurationMin?: number;
      weightKg?: number;
      volumeM3?: number;
      notes?: string;
      customFields?: Record<string, string> | null;
      timeWindowStartOffset?: number | null;
      timeWindowEndOffset?: number | null;
    }>;

    const routeDate = new Date(date || new Date());

    const [route] = await db
      .insert(routesTable)
      .values({
        organizationId,
        name: routeName || template.name,
        date: routeDate,
        vehicleId: vehicleId || null,
        totalStops: stopData.length,
      })
      .returning();

    if (stopData.length > 0) {
      const stopsToInsert: Array<typeof stopsTable.$inferInsert> = [];
      for (let idx = 0; idx < stopData.length; idx++) {
        const s = stopData[idx];
        let timeWindowStart = null;
        let timeWindowEnd = null;
        if (s.timeWindowStartOffset != null) {
          const d = new Date(routeDate);
          d.setHours(Math.floor(s.timeWindowStartOffset / 60), s.timeWindowStartOffset % 60, 0, 0);
          timeWindowStart = d;
        }
        if (s.timeWindowEndOffset != null) {
          const d = new Date(routeDate);
          d.setHours(Math.floor(s.timeWindowEndOffset / 60), s.timeWindowEndOffset % 60, 0, 0);
          timeWindowEnd = d;
        }
        const stopToInsert: Record<string, unknown> = {
          organizationId,
          routeId: route.id,
          address: s.address,
          latitude: s.latitude,
          longitude: s.longitude,
          serviceDurationMin: s.serviceDurationMin ?? 5,
          weightKg: s.weightKg ?? null,
          volumeM3: s.volumeM3 ?? null,
          notes: s.notes ?? null,
          customFields: s.customFields ?? null,
          sequenceOrder: idx + 1,
          timeWindowStart,
          timeWindowEnd,
        };
        cleanNavigationVerification(stopToInsert);
        const verified = await geocodeAddress(s.address);
        if (verified) applyVerifiedNavigationDestination(stopToInsert, verified);
        stopsToInsert.push(stopToInsert as typeof stopsTable.$inferInsert);
      }
      await db.insert(stopsTable).values(stopsToInsert);
    }

    res.status(201).json(route);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/route-templates/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = getOrgId(req);
    const [deleted] = await db
      .delete(routeTemplatesTable)
      .where(and(eq(routeTemplatesTable.id, id), eq(routeTemplatesTable.organizationId, organizationId)))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Template not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
