import { eq, and } from "drizzle-orm";
import { db, vehiclesTable } from "@workspace/db";

export async function listVehicles(organizationId: string) {
  return db.select().from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
}

export async function getVehicle(id: string, organizationId: string) {
  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(and(eq(vehiclesTable.id, id), eq(vehiclesTable.organizationId, organizationId)));
  return vehicle ?? null;
}

export async function createVehicle(data: Record<string, unknown>) {
  const [vehicle] = await db.insert(vehiclesTable).values(data as any).returning();
  return vehicle;
}

export async function updateVehicle(id: string, organizationId: string, data: Record<string, unknown>) {
  const [vehicle] = await db
    .update(vehiclesTable)
    .set(data as any)
    .where(and(eq(vehiclesTable.id, id), eq(vehiclesTable.organizationId, organizationId)))
    .returning();
  return vehicle ?? null;
}

export async function deleteVehicle(id: string, organizationId: string) {
  const [deleted] = await db
    .delete(vehiclesTable)
    .where(and(eq(vehiclesTable.id, id), eq(vehiclesTable.organizationId, organizationId)))
    .returning();
  return deleted ?? null;
}
