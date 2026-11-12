import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test from "node:test";
import { eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import { updateStop } from "./stop-service";
import { updateVehicle } from "./vehicle-service";

test("a material stop edit clears the route's geographic overlap explanation", async () => {
  const organizationId = randomUUID();
  const routeId = randomUUID();
  const stopId = randomUUID();

  try {
    await db.insert(organizationsTable).values({
      id: organizationId,
      name: "Stop explanation invalidation",
      email: `${organizationId}@example.test`,
    });
    await db.insert(routesTable).values({
      id: routeId,
      organizationId,
      name: "Explained route",
      date: new Date("2026-09-03T07:00:00.000Z"),
      status: "optimized",
      planRevision: 4,
      geographicOverlapExplanation: {
        status: "confirmed",
        reasonCode: "CAPACITY",
        message: "Tidigare förklaring",
        analyzedPairCount: 1,
        scope: { vehicleIds: ["vehicle-a", "vehicle-b"], stopIds: ["stop-a", "stop-b"] },
      },
    });
    await db.insert(stopsTable).values({
      id: stopId,
      organizationId,
      routeId,
      sequenceOrder: 1,
      address: "Stopp med ändrad vikt",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "pending",
      serviceDurationMin: 5,
      weightKg: 10,
      volumeM3: 0.1,
    });

    const updated = await updateStop(stopId, organizationId, { weightKg: 12 });
    assert.equal(updated?.weightKg, 12);

    const [route] = await db
      .select({
        explanation: routesTable.geographicOverlapExplanation,
        planRevision: routesTable.planRevision,
      })
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.equal(route.explanation, null);
    assert.equal(route.planRevision, 5);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("a resource edit clears sibling overlap evidence without changing plan revisions", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const routeIds = [randomUUID(), randomUUID()];
  const explanation = {
    status: "confirmed" as const,
    reasonCode: "CAPACITY" as const,
    message: "Kontrollerat par",
    analyzedPairCount: 1,
    scope: { vehicleIds: [vehicleId, randomUUID()], stopIds: [randomUUID(), randomUUID()] },
  };
  try {
    await db.insert(organizationsTable).values({
      id: organizationId,
      name: "Resource evidence invalidation",
      email: `${organizationId}@example.test`,
    });
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Evidence vehicle",
      licensePlate: `EVI-${organizationId.slice(0, 8)}`,
      capacityKg: 1_000,
      capacityVolume: 10,
      isActive: true,
    });
    await db.insert(routesTable).values(routeIds.map((id, index) => ({
      id,
      organizationId,
      vehicleId: index === 0 ? vehicleId : null,
      name: `Evidence route ${index}`,
      date: new Date("2026-09-04T07:00:00.000Z"),
      status: "optimized" as const,
      planRevision: 7,
      geographicOverlapExplanation: explanation,
    })));

    await updateVehicle(vehicleId, organizationId, { capacityKg: 1_100 });

    const routes = await db
      .select({
        explanation: routesTable.geographicOverlapExplanation,
        planRevision: routesTable.planRevision,
      })
      .from(routesTable)
      .where(eq(routesTable.organizationId, organizationId));
    assert.equal(routes.length, 2);
    assert.ok(routes.every((route) => route.explanation === null));
    assert.ok(routes.every((route) => route.planRevision === 7));

    await db
      .update(routesTable)
      .set({ geographicOverlapExplanation: explanation })
      .where(eq(routesTable.id, routeIds[0]));
    await updateVehicle(vehicleId, organizationId, { routeColor: "#0EA5E9" });
    const [cosmeticUpdateRoute] = await db
      .select({ explanation: routesTable.geographicOverlapExplanation })
      .from(routesTable)
      .where(eq(routesTable.id, routeIds[0]));
    assert.deepEqual(cosmeticUpdateRoute.explanation, explanation);
  } finally {
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});

test("assignment requirement edits invalidate owner planning and only sibling evidence", async () => {
  const organizationId = randomUUID();
  const routeIds = [randomUUID(), randomUUID()];
  const stopId = randomUUID();
  const explanation = {
    status: "confirmed" as const,
    reasonCode: "SKILL" as const,
    message: "Kontrollerat par",
    analyzedPairCount: 1,
    scope: { vehicleIds: [randomUUID(), randomUUID()], stopIds: [stopId, randomUUID()] },
  };
  try {
    await db.insert(organizationsTable).values({
      id: organizationId,
      name: "Assignment evidence invalidation",
      email: `${organizationId}@example.test`,
    });
    await db.insert(routesTable).values(routeIds.map((id) => ({
      id,
      organizationId,
      name: `Assignment route ${id}`,
      date: new Date("2026-09-05T07:00:00.000Z"),
      status: "optimized" as const,
      planRevision: 3,
      geographicOverlapExplanation: explanation,
    })));
    await db.insert(stopsTable).values({
      id: stopId,
      organizationId,
      routeId: routeIds[0],
      sequenceOrder: 1,
      address: "Assignment stop",
      latitude: 59.3293,
      longitude: 18.0686,
      status: "pending",
      serviceDurationMin: 5,
      weightKg: 10,
      volumeM3: 0.1,
    });

    await updateStop(stopId, organizationId, {
      jobType: "pickup_delivery",
      requiredSkills: ["lift"],
      requiredCertifications: ["ADR"],
      requiredEquipment: ["tail_lift"],
    });

    const routes = await db
      .select({
        id: routesTable.id,
        explanation: routesTable.geographicOverlapExplanation,
        planRevision: routesTable.planRevision,
      })
      .from(routesTable)
      .where(eq(routesTable.organizationId, organizationId));
    const owner = routes.find((route) => route.id === routeIds[0])!;
    const counterpart = routes.find((route) => route.id === routeIds[1])!;
    assert.equal(owner.explanation, null);
    assert.equal(owner.planRevision, 4);
    assert.equal(counterpart.explanation, null);
    assert.equal(counterpart.planRevision, 3);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});