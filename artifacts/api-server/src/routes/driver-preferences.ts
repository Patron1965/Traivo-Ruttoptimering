import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, driversTable, driverPreferencesTable, routesTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { z } from "zod/v4";
import { computeHappinessScore } from "../services/happiness-score";
import {
  assertCurrentDriverAssistance,
  DriverAssistanceError,
  getDriverAssistanceContext,
  validateDriverAssistanceContext,
} from "../lib/driver-assistance";

const router: IRouter = Router();

const updatePreferencesSchema = z.object({
  preferredStartTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  preferredEndTime: z.string().regex(/^\d{2}:\d{2}(:\d{2})?$/).optional(),
  maxDrivingHoursPerDay: z.number().min(1).max(24).optional(),
  breakFrequencyMinutes: z.number().int().min(30).max(480).optional(),
  preferredBreakDurationMin: z.number().int().min(5).max(60).optional(),
  avoidNightDriving: z.boolean().optional(),
});

async function verifyDriverOrg(driverId: string, organizationId: string) {
  const [driver] = await db
    .select()
    .from(driversTable)
    .where(and(eq(driversTable.id, driverId), eq(driversTable.organizationId, organizationId)));
  return driver ?? null;
}

router.get("/drivers/:id/preferences", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    await validateDriverAssistanceContext(req, { driverId: id });
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    const driver = await verifyDriverOrg(id, organizationId);
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }

    let [prefs] = await db
      .select()
      .from(driverPreferencesTable)
      .where(eq(driverPreferencesTable.driverId, id));

    if (!prefs) {
      [prefs] = await db
        .insert(driverPreferencesTable)
        .values({ driverId: id })
        .returning();
    }

    res.json(prefs);
  } catch (err) {
    if (err instanceof DriverAssistanceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

router.put("/drivers/:id/preferences", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const assistance = getDriverAssistanceContext(req);
    if (assistance && assistance.driverId !== id) {
      throw new DriverAssistanceError(
        "The request is outside the selected driver assistance scope",
        409,
      );
    }
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    const parsed = updatePreferencesSchema.parse(req.body);

    const updateData: Record<string, unknown> = {};
    if (parsed.preferredStartTime !== undefined) updateData.preferredStartTime = parsed.preferredStartTime;
    if (parsed.preferredEndTime !== undefined) updateData.preferredEndTime = parsed.preferredEndTime;
    if (parsed.maxDrivingHoursPerDay !== undefined) updateData.maxDrivingHoursPerDay = parsed.maxDrivingHoursPerDay;
    if (parsed.breakFrequencyMinutes !== undefined) updateData.breakFrequencyMinutes = parsed.breakFrequencyMinutes;
    if (parsed.preferredBreakDurationMin !== undefined) updateData.preferredBreakDurationMin = parsed.preferredBreakDurationMin;
    if (parsed.avoidNightDriving !== undefined) updateData.avoidNightDriving = parsed.avoidNightDriving;

    const prefs = await db.transaction(async (tx) => {
      if (assistance) {
        const [lockedRoute] = await tx.select().from(routesTable).where(and(
          eq(routesTable.id, assistance.routeId),
          eq(routesTable.organizationId, organizationId),
        )).limit(1).for("update");
        if (!lockedRoute) {
          throw new DriverAssistanceError("The selected route is no longer available", 409);
        }
        assertCurrentDriverAssistance(lockedRoute, assistance);
      }

      const [driver] = await tx.select().from(driversTable).where(and(
        eq(driversTable.id, id),
        eq(driversTable.organizationId, organizationId),
        assistance ? eq(driversTable.isActive, true) : undefined,
      )).limit(1);
      if (!driver) return null;

      const [existing] = await tx
        .select()
        .from(driverPreferencesTable)
        .where(eq(driverPreferencesTable.driverId, id));
      if (existing) {
        const [updated] = await tx
          .update(driverPreferencesTable)
          .set(updateData)
          .where(eq(driverPreferencesTable.driverId, id))
          .returning();
        return updated;
      }
      const [created] = await tx
        .insert(driverPreferencesTable)
        .values({ driverId: id, ...updateData })
        .returning();
      return created;
    });
    if (!prefs) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }

    const happinessScore = await computeHappinessScore(id, organizationId, prefs);
    let result = prefs;
    if (happinessScore !== prefs.happinessScore) {
      [result] = await db
        .update(driverPreferencesTable)
        .set({ happinessScore })
        .where(eq(driverPreferencesTable.driverId, id))
        .returning();
    }

    res.json(result);
  } catch (err) {
    if (err instanceof DriverAssistanceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

export { computeHappinessScore } from "../services/happiness-score";

export default router;
