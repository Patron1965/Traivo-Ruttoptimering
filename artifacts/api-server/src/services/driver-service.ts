import { eq, and, ne } from "drizzle-orm";
import { db, driversTable, vehiclesTable } from "@workspace/db";

export async function listDrivers(organizationId: string) {
  return db.select().from(driversTable).where(eq(driversTable.organizationId, organizationId));
}

export async function getDriver(id: string, organizationId: string) {
  const [driver] = await db
    .select()
    .from(driversTable)
    .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId)));
  return driver ?? null;
}

export async function createDriver(data: {
  name: string;
  phone?: string;
  email?: string;
  vehicleId?: string;
  organizationId: string;
  isActive?: boolean;
}) {
  if (data.vehicleId) {
    const [vehicle] = await db
      .select()
      .from(vehiclesTable)
      .where(and(eq(vehiclesTable.id, data.vehicleId), eq(vehiclesTable.organizationId, data.organizationId)));
    if (!vehicle) return { error: "Vehicle not found in this organization", status: 400 };

    const [existing] = await db
      .select()
      .from(driversTable)
      .where(and(eq(driversTable.vehicleId, data.vehicleId), eq(driversTable.isActive, true), eq(driversTable.organizationId, data.organizationId)))
      .limit(1);
    if (existing) return { error: `Vehicle is already assigned to driver ${existing.name}`, status: 409 };
  }

  const [driver] = await db
    .insert(driversTable)
    .values({ name: data.name, phone: data.phone, email: data.email, vehicleId: data.vehicleId, organizationId: data.organizationId, isActive: data.isActive ?? true })
    .returning();
  return { data: driver };
}

export async function updateDriver(id: string, organizationId: string, updates: Record<string, unknown>) {
  const [currentDriver] = await db
    .select()
    .from(driversTable)
    .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId)));
  if (!currentDriver) return { error: "Driver not found", status: 404 };

  const vehicleId = updates.vehicleId !== undefined ? updates.vehicleId as string : currentDriver.vehicleId;
  const isActive = updates.isActive !== undefined ? updates.isActive as boolean : currentDriver.isActive;

  if (updates.vehicleId && updates.vehicleId !== currentDriver.vehicleId) {
    const [vehicle] = await db
      .select()
      .from(vehiclesTable)
      .where(and(eq(vehiclesTable.id, updates.vehicleId as string), eq(vehiclesTable.organizationId, organizationId)));
    if (!vehicle) return { error: "Vehicle not found in this organization", status: 400 };
  }

  if (vehicleId && isActive) {
    const [existing] = await db
      .select()
      .from(driversTable)
      .where(and(eq(driversTable.vehicleId, vehicleId), eq(driversTable.isActive, true), eq(driversTable.organizationId, organizationId), ne(driversTable.id, id)))
      .limit(1);
    if (existing) return { error: `Vehicle is already assigned to driver ${existing.name}`, status: 409 };
  }

  const [driver] = await db
    .update(driversTable)
    .set(updates as any)
    .where(eq(driversTable.id, id))
    .returning();
  if (!driver) return { error: "Driver not found", status: 404 };

  return { data: driver };
}

export async function deleteDriver(id: string, organizationId: string) {
  const [deleted] = await db
    .delete(driversTable)
    .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId)))
    .returning();
  return deleted ?? null;
}
