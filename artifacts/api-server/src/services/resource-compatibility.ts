import { and, eq, isNull } from "drizzle-orm";
import { db, driversTable, organizationsTable, vehiclesTable } from "@workspace/db";

/**
 * Additive compatibility migration: vehicle IDs are resource IDs. Existing
 * profiles and all account/route references retain their original identities.
 * Serializing on the organization also makes concurrent server starts safe.
 */
export async function ensureResourceProfiles(onlyOrganizationId?: string) {
  const organizations = await db.select({ id: organizationsTable.id }).from(organizationsTable)
    .where(onlyOrganizationId ? eq(organizationsTable.id, onlyOrganizationId) : undefined);
  for (const { id: organizationId } of organizations) {
    await db.transaction(async (tx) => {
      await tx.select({ id: organizationsTable.id }).from(organizationsTable)
        .where(eq(organizationsTable.id, organizationId)).for("update");
      const vehicles = await tx.select().from(vehiclesTable).where(and(
        eq(vehiclesTable.organizationId, organizationId), eq(vehiclesTable.isActive, true),
      )).for("update");
      const drivers = await tx.select().from(driversTable).where(and(
        eq(driversTable.organizationId, organizationId), eq(driversTable.isActive, true),
      )).for("update");
      for (const vehicle of vehicles) {
        const matching = drivers.filter((driver) => driver.vehicleId === vehicle.id);
        if (matching.length > 1) {
          // Never choose a person or rewrite old handoffs automatically.
          // Keep this resource unchanged; unrelated tenants must still start.
          console.warn("[resources] Legacy resource has multiple active profiles; migration left it unchanged.");
          continue;
        }
        if (!matching.length) {
          await tx.insert(driversTable).values({ organizationId, vehicleId: vehicle.id, name: vehicle.name });
        }
      }
      let sortOrder = Math.max(-1, ...vehicles.map((vehicle) => vehicle.sortOrder)) + 1;
      for (const driver of drivers.filter((candidate) => candidate.vehicleId === null)) {
        // Preserve the existing driver identity (including linked login accounts).
        const [vehicle] = await tx.insert(vehiclesTable).values({
          organizationId, name: driver.name, licensePlate: "", sortOrder: sortOrder++,
          ...(driver.capacityKg == null ? {} : { capacityKg: driver.capacityKg }),
          ...(driver.capacityVolume == null ? {} : { capacityVolume: driver.capacityVolume }),
        }).returning();
        await tx.update(driversTable).set({ vehicleId: vehicle.id })
          .where(and(eq(driversTable.id, driver.id), isNull(driversTable.vehicleId)));
      }
    });
  }
}
