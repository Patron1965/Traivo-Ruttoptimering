import { and, eq, inArray } from "drizzle-orm";
import { db, vehiclesTable, driversTable, driverCertificationsTable, customersTable } from "@workspace/db";

type Transaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
/** Row locks cover resource edits and FK-backed certification/driver inserts. */
export async function lockDispatchBindingFacts(
  tx: Transaction, organizationId: string, vehicleIds: string[], customerIds: string[],
) {
  const vehicles = vehicleIds.length ? await tx.select().from(vehiclesTable).where(and(
    eq(vehiclesTable.organizationId, organizationId), inArray(vehiclesTable.id, vehicleIds),
  )).orderBy(vehiclesTable.id).for("update") : [];
  const drivers = vehicleIds.length ? await tx.select().from(driversTable).where(and(
    eq(driversTable.organizationId, organizationId), inArray(driversTable.vehicleId, vehicleIds),
  )).orderBy(driversTable.id).for("update") : [];
  const certifications = drivers.length ? await tx.select().from(driverCertificationsTable).where(and(
    eq(driverCertificationsTable.organizationId, organizationId), inArray(driverCertificationsTable.driverId, drivers.map((driver) => driver.id)),
  )).orderBy(driverCertificationsTable.id).for("update") : [];
  const customers = customerIds.length ? await tx.select().from(customersTable).where(and(
    eq(customersTable.organizationId, organizationId), inArray(customersTable.id, customerIds),
  )).orderBy(customersTable.id).for("update") : [];
  return { vehicles, drivers, certifications, customers };
}
