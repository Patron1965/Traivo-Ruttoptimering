import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { eq } from "drizzle-orm";
import { db, organizationsTable, driversTable, vehiclesTable } from "@workspace/db";
import { createVehicle, updateVehicle, getVehicle, deleteVehicle } from "./vehicle-service";
import { ensureResourceProfiles } from "./resource-compatibility";

test("resource create/edit and additive migration preserve identity without manual pairing", async () => {
  const organizationId = randomUUID();
  await db.insert(organizationsTable).values({ id: organizationId, name: "Resource compatibility test", email: `${organizationId}@resource.test` });
  try {
    const resource = await createVehicle({ organizationId, name: "Anders", vehicleType: "fossil", capacityKg: 100, capacityVolume: 2 });
    assert.equal(resource.licensePlate, "");
    assert.equal(resource.resourceProfile?.vehicleId, resource.id);
    const profileId = resource.resourceProfile!.id;
    await updateVehicle(resource.id, organizationId, {
      name: "Bil 1 – Anders", driver: { name: "Bil 1 – Anders", workStartTime: "07:00", capacityKg: 90 },
    });
    const updated = await getVehicle(resource.id, organizationId);
    assert.equal(updated?.resourceProfile?.id, profileId);
    assert.equal(updated?.resourceProfile?.workStartTime, "07:00");
    assert.equal(updated?.resourceProfile?.capacityKg, 90);
    assert.equal(await getVehicle(resource.id, randomUUID()), null);
    const [legacyVehicle] = await db.insert(vehiclesTable).values({ organizationId, name: "Legacy", licensePlate: "" }).returning();
    const [legacyDriver] = await db.insert(driversTable).values({ organizationId, name: "Legacy person", capacityKg: 80 }).returning();
    await ensureResourceProfiles(organizationId);
    await ensureResourceProfiles(organizationId);
    const profiles = await db.select().from(driversTable).where(eq(driversTable.organizationId, organizationId));
    assert.equal(profiles.filter((p) => p.vehicleId === resource.id).length, 1);
    assert.equal(profiles.filter((p) => p.vehicleId === legacyVehicle.id).length, 1);
    const preserved = profiles.find((p) => p.id === legacyDriver.id)!;
    assert.ok(preserved.vehicleId);
    assert.equal(preserved.capacityKg, 80);
    await deleteVehicle(resource.id, organizationId);
    await ensureResourceProfiles(organizationId);
    const [removedProfile] = await db.select().from(driversTable).where(eq(driversTable.id, profileId));
    assert.equal(removedProfile.isActive, false);
    assert.equal(removedProfile.vehicleId, resource.id);
  } finally {
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});
