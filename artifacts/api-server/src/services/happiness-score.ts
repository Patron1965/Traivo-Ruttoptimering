import { eq, and } from "drizzle-orm";
import { db, driversTable, driverPreferencesTable, routesTable } from "@workspace/db";

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

  // Routes currently persist their planned date and generic update timestamp,
  // not authoritative execution start/completion times. A neutral score is
  // safer than presenting timing-derived driver metrics from unrelated fields.
  void prefs;
  return 0.5;
}
