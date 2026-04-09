import { eq, and } from "drizzle-orm";
import { db, driversTable, driverPreferencesTable, routesTable, stopsTable } from "@workspace/db";

export async function computeHappinessScore(
  driverId: string,
  organizationId: string,
  prefs: typeof driverPreferencesTable.$inferSelect
): Promise<number> {
  const [driver] = await db
    .select()
    .from(driversTable)
    .where(and(eq(driversTable.id, driverId), eq(driversTable.organizationId, organizationId)));
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
