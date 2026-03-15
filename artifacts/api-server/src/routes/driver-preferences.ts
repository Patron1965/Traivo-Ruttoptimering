import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, driversTable, driverPreferencesTable, routesTable, stopsTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { z } from "zod/v4";

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
    const organizationId = req.query.organizationId as string;
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
    handleError(res, err);
  }
});

router.put("/drivers/:id/preferences", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.query.organizationId as string;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }

    const driver = await verifyDriverOrg(id, organizationId);
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
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

    const [existing] = await db
      .select()
      .from(driverPreferencesTable)
      .where(eq(driverPreferencesTable.driverId, id));

    let prefs;
    if (existing) {
      [prefs] = await db
        .update(driverPreferencesTable)
        .set(updateData)
        .where(eq(driverPreferencesTable.driverId, id))
        .returning();
    } else {
      [prefs] = await db
        .insert(driverPreferencesTable)
        .values({ driverId: id, ...updateData })
        .returning();
    }

    const happinessScore = await computeHappinessScore(id, organizationId, prefs);
    if (happinessScore !== prefs.happinessScore) {
      [prefs] = await db
        .update(driverPreferencesTable)
        .set({ happinessScore })
        .where(eq(driverPreferencesTable.driverId, id))
        .returning();
    }

    res.json(prefs);
  } catch (err) {
    handleError(res, err);
  }
});

export async function computeHappinessScore(
  driverId: string,
  organizationId: string,
  prefs: typeof driverPreferencesTable.$inferSelect
): Promise<number> {
  const driver = await verifyDriverOrg(driverId, organizationId);
  if (!driver || !driver.vehicleId) return 0.5;

  const routes = await db
    .select()
    .from(routesTable)
    .where(
      and(
        eq(routesTable.vehicleId, driver.vehicleId),
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.status, "completed")
      )
    );

  if (routes.length === 0) return 0.5;

  const recentRoutes = routes.slice(-20);

  let timeMatchTotal = 0;
  let overtimeTotal = 0;
  let breakAdherenceTotal = 0;
  let routeCount = 0;

  const prefStartMinutes = parseTimeToMinutes(prefs.preferredStartTime ?? "07:00:00");
  const prefEndMinutes = parseTimeToMinutes(prefs.preferredEndTime ?? "16:00:00");
  const maxHours = prefs.maxDrivingHoursPerDay ?? 8;
  const prefBreakFrequency = prefs.breakFrequencyMinutes ?? 120;

  for (const route of recentRoutes) {
    if (!route.startedAt) continue;
    routeCount++;

    const routeStartMinutes = route.startedAt.getHours() * 60 + route.startedAt.getMinutes();
    const startDiff = Math.abs(routeStartMinutes - prefStartMinutes);
    const startScore = Math.max(0, 1 - startDiff / 120);

    let endScore = 1;
    let drivingMinutes = 0;
    if (route.completedAt) {
      const routeEndMinutes = route.completedAt.getHours() * 60 + route.completedAt.getMinutes();
      const endDiff = Math.max(0, routeEndMinutes - prefEndMinutes);
      endScore = Math.max(0, 1 - endDiff / 120);

      drivingMinutes = (route.completedAt.getTime() - route.startedAt.getTime()) / 60000;
      const drivingHours = drivingMinutes / 60;
      const overtime = Math.max(0, drivingHours - maxHours);
      overtimeTotal += overtime;
    }

    timeMatchTotal += (startScore + endScore) / 2;

    if (drivingMinutes > 0) {
      const expectedBreaks = Math.floor(drivingMinutes / prefBreakFrequency);
      const routeStops = await db
        .select()
        .from(stopsTable)
        .where(eq(stopsTable.routeId, route.id));
      const completedStops = routeStops.filter((s) => s.status === "completed");
      const naturalBreaks = completedStops.length > 0 ? Math.max(0, completedStops.length - 1) : 0;
      const breakScore = expectedBreaks > 0
        ? Math.min(1, naturalBreaks / expectedBreaks)
        : 1;
      breakAdherenceTotal += breakScore;
    } else {
      breakAdherenceTotal += 1;
    }
  }

  if (routeCount === 0) return 0.5;

  const avgTimeMatch = timeMatchTotal / routeCount;
  const avgOvertime = overtimeTotal / routeCount;
  const overtimeScore = Math.max(0, 1 - avgOvertime / 3);
  const avgBreakAdherence = breakAdherenceTotal / routeCount;

  const score = avgTimeMatch * 0.5 + overtimeScore * 0.3 + avgBreakAdherence * 0.2;
  return Math.round(Math.max(0, Math.min(1, score)) * 100) / 100;
}

function parseTimeToMinutes(time: string): number {
  const parts = time.split(":");
  return parseInt(parts[0], 10) * 60 + parseInt(parts[1], 10);
}

export default router;
