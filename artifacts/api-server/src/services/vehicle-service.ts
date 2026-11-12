import { eq, and, inArray, asc, max } from "drizzle-orm";
import { db, driversTable, routesTable, vehiclesTable } from "@workspace/db";
import { broadcastDataChange } from "./realtime";

export async function listVehicles(organizationId: string) {
  const vehicles = await db
    .select()
    .from(vehiclesTable)
    .where(and(eq(vehiclesTable.organizationId, organizationId), eq(vehiclesTable.isActive, true)))
    .orderBy(asc(vehiclesTable.sortOrder), asc(vehiclesTable.createdAt));
  const profiles = await db.select().from(driversTable).where(and(
    eq(driversTable.organizationId, organizationId), eq(driversTable.isActive, true),
  ));
  return vehicles.map((vehicle) => ({
    ...vehicle,
    resourceProfile: profiles.filter((profile) => profile.vehicleId === vehicle.id).length === 1
      ? profiles.find((profile) => profile.vehicleId === vehicle.id)! : null,
  }));
}

export async function getVehicle(id: string, organizationId: string) {
  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(and(eq(vehiclesTable.id, id), eq(vehiclesTable.organizationId, organizationId)));
  if (!vehicle) return null;
  const profiles = await db.select().from(driversTable).where(and(
    eq(driversTable.organizationId, organizationId), eq(driversTable.vehicleId, id),
    eq(driversTable.isActive, true),
  ));
  return { ...vehicle, resourceProfile: profiles.length === 1 ? profiles[0] : null };
}

type AssignedDriverInput = {
  name: string;
  phone?: string | null;
  email?: string | null;
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
};

export async function createVehicle(
  data: Record<string, unknown>,
  driverInput?: AssignedDriverInput,
) {
  // The profile is an internal compatibility record, never a separate setup step.
  const normalizedDriverName = driverInput?.name.trim() || String(data.name).trim();
  const result = await db.transaction(async (tx) => {
    const organizationId = String(data.organizationId);
    const [{ highestSortOrder }] = await tx
      .select({ highestSortOrder: max(vehiclesTable.sortOrder) })
      .from(vehiclesTable)
      .where(and(eq(vehiclesTable.organizationId, organizationId), eq(vehiclesTable.isActive, true)));
    const [vehicle] = await tx
      .insert(vehiclesTable)
      .values({ ...data, licensePlate: data.licensePlate ?? "", sortOrder: (highestSortOrder ?? -1) + 1 } as any)
      .returning();
    const [driver] = normalizedDriverName
      ? await tx
          .insert(driversTable)
          .values({
            organizationId: vehicle.organizationId,
            name: normalizedDriverName,
            vehicleId: vehicle.id,
             phone: driverInput?.phone,
             email: driverInput?.email,
             workStartTime: driverInput?.workStartTime,
             workEndTime: driverInput?.workEndTime,
             breakStartTime: driverInput?.breakStartTime,
             breakEndTime: driverInput?.breakEndTime,
             tempo: driverInput?.tempo,
             capacityKg: driverInput?.capacityKg,
             capacityVolume: driverInput?.capacityVolume,
             startAddress: driverInput?.startAddress,
             startLatitude: driverInput?.startLatitude,
             startLongitude: driverInput?.startLongitude,
             endAddress: driverInput?.endAddress,
             endLatitude: driverInput?.endLatitude,
             endLongitude: driverInput?.endLongitude,
             driverRole: driverInput?.driverRole,
             skills: driverInput?.skills,
          })
          .returning()
      : [];
    return { vehicle, driver };
  });
  const { vehicle, driver } = result;
  broadcastDataChange(vehicle.organizationId, "vehicle", "created", { id: vehicle.id, name: vehicle.name });
  if (driver) {
    broadcastDataChange(vehicle.organizationId, "driver", "created", { id: driver.id, name: driver.name });
  }
  return { ...vehicle, resourceProfile: driver ?? null };
}

export async function updateVehicle(id: string, organizationId: string, data: Record<string, unknown>) {
  const { driver: profileInput, ...vehicleInput } = data;
  const vehicle = await db.transaction(async (tx) => {
    const [current] = await tx.select().from(vehiclesTable).where(and(
      eq(vehiclesTable.id, id), eq(vehiclesTable.organizationId, organizationId),
    )).for("update");
    if (!current) return null;
    const profiles = await tx.select().from(driversTable).where(and(
      eq(driversTable.vehicleId, id), eq(driversTable.organizationId, organizationId),
      eq(driversTable.isActive, true),
    )).for("update");
    if (profiles.length > 1) throw Object.assign(new Error("Resursen har flera äldre profiler och behöver granskas."), { statusCode: 409 });
    const [updated] = Object.keys(vehicleInput).length
      ? await tx.update(vehiclesTable).set(vehicleInput as any).where(eq(vehiclesTable.id, id)).returning()
      : [current];
    const profile = profileInput as AssignedDriverInput | undefined;
    const profileValues = { ...profile, name: updated.name };
    if (profiles[0] && (profile || vehicleInput.name !== undefined)) {
      await tx.update(driversTable).set(profileValues).where(eq(driversTable.id, profiles[0].id));
    } else if (!profiles[0]) {
      await tx.insert(driversTable).values({ ...profileValues, organizationId, vehicleId: id });
    }
    if (profile) {
      await tx.update(routesTable).set({ geographicOverlapExplanation: null }).where(eq(routesTable.organizationId, organizationId));
    }
    return updated;
  });
  if (vehicle) {
    // Evidence may mention this vehicle as the *other* route in a nearby pair.
    // Clear all organization evidence without altering route revision, handoff,
    // or approval state; those represent the plan, not this derived display
    // evidence.
    const evaluatorInputChanged = [
      "vehicleType",
      "capacityKg",
      "capacityVolume",
      "batteryCapacityKwh",
      "currentBatteryPercent",
      "rangeKm",
      "isActive",
      "equipmentInventory",
    ].some((field) => Object.prototype.hasOwnProperty.call(data, field));
    if (evaluatorInputChanged) {
      await db
        .update(routesTable)
        .set({ geographicOverlapExplanation: null })
        .where(eq(routesTable.organizationId, organizationId));
    }
    broadcastDataChange(organizationId, "vehicle", "updated", { id: vehicle.id, name: vehicle.name });
    broadcastDataChange(organizationId, "driver", "updated", { vehicleId: vehicle.id });
  }
  return vehicle ? getVehicle(id, organizationId) : null;
}

export async function reorderVehicles(vehicleIds: string[], organizationId: string) {
  await db.transaction(async (tx) => {
    const activeVehicles = await tx
      .select({ id: vehiclesTable.id })
      .from(vehiclesTable)
      .where(and(eq(vehiclesTable.organizationId, organizationId), eq(vehiclesTable.isActive, true)));
    const activeIds = new Set(activeVehicles.map((vehicle) => vehicle.id));
    if (activeIds.size !== vehicleIds.length || vehicleIds.some((id) => !activeIds.has(id))) {
      const error = new Error("Vehicle list changed; refresh and try again");
      Object.assign(error, { statusCode: 409 });
      throw error;
    }
    for (const [sortOrder, id] of vehicleIds.entries()) {
      await tx
        .update(vehiclesTable)
        .set({ sortOrder })
        .where(and(eq(vehiclesTable.id, id), eq(vehiclesTable.organizationId, organizationId)));
    }
  });
  const vehicles = await listVehicles(organizationId);
  broadcastDataChange(organizationId, "vehicle", "updated", { reordered: true });
  return vehicles;
}

export async function deleteVehicle(id: string, organizationId: string) {
  const [vehicle] = await db
    .select()
    .from(vehiclesTable)
    .where(and(eq(vehiclesTable.id, id), eq(vehiclesTable.organizationId, organizationId), eq(vehiclesTable.isActive, true)));
  if (!vehicle) return null;

  const activeRoutes = await db
    .select({ id: routesTable.id })
    .from(routesTable)
    .where(and(
      eq(routesTable.organizationId, organizationId),
      eq(routesTable.vehicleId, id),
      inArray(routesTable.status, ["draft", "optimized", "in_progress"]),
    ))
    .limit(1);

  if (activeRoutes.length > 0) {
    const error = new Error("Vehicle is assigned to an active or planned route");
    Object.assign(error, { statusCode: 409 });
    throw error;
  }

  const result = await db.transaction(async (tx) => {
    const unassignedDrivers = await tx
      .update(driversTable)
      // Retain the identity for account/history references; never recreate a
      // removed resource from an orphaned active profile at the next startup.
      .set({ isActive: false })
      .where(and(eq(driversTable.organizationId, organizationId), eq(driversTable.vehicleId, id)))
      .returning({ id: driversTable.id });

    const [archived] = await tx
      .update(vehiclesTable)
      .set({ isActive: false })
      .where(and(eq(vehiclesTable.id, id), eq(vehiclesTable.organizationId, organizationId), eq(vehiclesTable.isActive, true)))
      .returning();

    if (archived) {
      await tx
        .update(routesTable)
        .set({ geographicOverlapExplanation: null })
        .where(eq(routesTable.organizationId, organizationId));
    }
    return { archived, unassignedDrivers };
  });

  if (result.archived) {
    broadcastDataChange(organizationId, "vehicle", "deleted", { id });
    for (const driver of result.unassignedDrivers) {
      broadcastDataChange(organizationId, "driver", "updated", { id: driver.id });
    }
  }
  return result.archived ?? null;
}
