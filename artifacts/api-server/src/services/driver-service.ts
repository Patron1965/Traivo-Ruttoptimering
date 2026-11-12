import { eq, and, ne } from "drizzle-orm";
import { db, driversTable, routesTable, vehiclesTable } from "@workspace/db";
import { broadcastDataChange } from "./realtime";

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
  workStartTime?: string | null;
  workEndTime?: string | null;
  breakStartTime?: string | null;
  breakEndTime?: string | null;
  tempo?: "slow" | "normal" | "fast" | null;
  capacityKg?: number | null;
  capacityVolume?: number | null;
  startAddress?: string | null;
  startLatitude?: number | null;
  startLongitude?: number | null;
  endAddress?: string | null;
  endLatitude?: number | null;
  endLongitude?: number | null;
  driverRole?: "driver" | "technician" | "both";
  skills?: string[] | null;
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
    .values({
      name: data.name, phone: data.phone, email: data.email, vehicleId: data.vehicleId,
      organizationId: data.organizationId, isActive: data.isActive ?? true,
      workStartTime: data.workStartTime, workEndTime: data.workEndTime,
      breakStartTime: data.breakStartTime, breakEndTime: data.breakEndTime,
      tempo: data.tempo, capacityKg: data.capacityKg, capacityVolume: data.capacityVolume,
      startAddress: data.startAddress, startLatitude: data.startLatitude, startLongitude: data.startLongitude,
      endAddress: data.endAddress, endLatitude: data.endLatitude, endLongitude: data.endLongitude,
      driverRole: data.driverRole, skills: data.skills,
    })
    .returning();
  if (driver.vehicleId) {
    await db
      .update(routesTable)
      .set({ geographicOverlapExplanation: null })
      .where(eq(routesTable.organizationId, data.organizationId));
  }
  broadcastDataChange(data.organizationId, "driver", "created", { id: driver.id, name: driver.name });
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

  const evaluatorInputChanged = [
    "vehicleId",
    "isActive",
    "workStartTime",
    "workEndTime",
    "breakStartTime",
    "breakEndTime",
    "tempo",
    "capacityKg",
    "capacityVolume",
    "startLatitude",
    "startLongitude",
    "endLatitude",
    "endLongitude",
    "driverRole",
    "skills",
  ].some((field) => Object.prototype.hasOwnProperty.call(updates, field));
  // Driver working hours, skills, and pairing are evaluator inputs. Clear
  // derived overlap evidence for both sides of any affected pair, while
  // preserving plan revisions and approval/handoff semantics. Contact/name
  // edits deliberately do not invalidate feasibility evidence.
  if (evaluatorInputChanged) {
    await db
      .update(routesTable)
      .set({ geographicOverlapExplanation: null })
      .where(eq(routesTable.organizationId, organizationId));
  }
  broadcastDataChange(organizationId, "driver", "updated", { id: driver.id, name: driver.name });
  return { data: driver };
}

export async function deleteDriver(id: string, organizationId: string) {
  const [deleted] = await db
    .delete(driversTable)
    .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId)))
    .returning();
  if (deleted) {
    await db
      .update(routesTable)
      .set({ geographicOverlapExplanation: null })
      .where(eq(routesTable.organizationId, organizationId));
    broadcastDataChange(organizationId, "driver", "deleted", { id });
  }
  return deleted ?? null;
}
