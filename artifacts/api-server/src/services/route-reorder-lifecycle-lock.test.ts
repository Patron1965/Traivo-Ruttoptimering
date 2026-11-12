import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { asc, eq } from "drizzle-orm";
import {
  db,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import { reorderStops, updateRoute } from "./route-service";

test("route reorder uses revision CAS and preserves lifecycle-locked positions", async () => {
  const organizationId = randomUUID();
  const vehicleId = randomUUID();
  const routeId = randomUUID();
  const lockedStopId = randomUUID();
  const pendingStopId = randomUUID();
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Route reorder lifecycle-lock test",
    email: `${organizationId}@example.test`,
  });
  try {
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Route reorder vehicle",
      licensePlate: `RR-${vehicleId.slice(0, 8)}`,
    });
    await db.insert(routesTable).values({
      id: routeId,
      organizationId,
      vehicleId,
      name: "Route reorder lifecycle-lock route",
      date: new Date("2026-09-07T00:00:00.000Z"),
      planRevision: 3,
    });
    await db.insert(stopsTable).values([
      {
        id: lockedStopId,
        organizationId,
        routeId,
        address: "Locked route anchor",
        latitude: 59.3293,
        longitude: 18.0686,
        status: "completed",
        sequenceOrder: 1,
      },
      {
        id: pendingStopId,
        organizationId,
        routeId,
        address: "Pending route stop",
        latitude: 59.3393,
        longitude: 18.0786,
        status: "pending",
        sequenceOrder: 2,
      },
    ]);

    const shifted = await reorderStops(
      routeId,
      organizationId,
      [pendingStopId, lockedStopId],
      3,
    );
    assert.equal("status" in shifted ? shifted.status : undefined, 409);

    const stale = await reorderStops(
      routeId,
      organizationId,
      [lockedStopId, pendingStopId],
      2,
    );
    assert.equal("status" in stale ? stale.status : undefined, 409);

    const unchanged = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, routeId))
      .orderBy(asc(stopsTable.sequenceOrder));
    assert.deepEqual(
      unchanged.map((stop) => [stop.id, stop.status, stop.sequenceOrder]),
      [
        [lockedStopId, "completed", 1],
        [pendingStopId, "pending", 2],
      ],
    );
    const [route] = await db
      .select()
      .from(routesTable)
      .where(eq(routesTable.id, routeId));
    assert.equal(route.planRevision, 3);

    await assert.rejects(
      updateRoute(
        routeId,
        organizationId,
        { vehicleId: null },
        {},
        3,
      ),
      /atomic planning or dispatch/i,
    );
    await db
      .update(routesTable)
      .set({ status: "completed" })
      .where(eq(routesTable.id, routeId));
    await assert.rejects(
      updateRoute(
        routeId,
        organizationId,
        { status: "in_progress" },
        {},
        3,
      ),
      /cannot be reopened/i,
    );
    await assert.rejects(
      updateRoute(
        routeId,
        organizationId,
        { status: "completed" },
        {},
        2,
      ),
      (error: unknown) => error instanceof Error && "statusCode" in error && error.statusCode === 409,
    );
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});