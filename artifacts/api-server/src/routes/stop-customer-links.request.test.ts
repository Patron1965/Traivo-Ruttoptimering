import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { test } from "node:test";
import {
  db,
  customersTable,
  organizationsTable,
  sessionsTable,
  stopsTable,
  usersTable,
} from "@workspace/db";
import app from "../app";
import { createSession } from "../lib/session";
import { eq, inArray } from "drizzle-orm";
import { materializeUnplannedCustomerStopSnapshots } from "../services/stop-service";
import { normalizePlanningInputs, toAlnsNode } from "../services/import-route-workflow";
import { evaluateRouteWorkday } from "../services/route-workday";

test("stop customer links reject cross-tenant and archived customers over HTTP", async () => {
  const organizationId = randomUUID();
  const otherOrganizationId = randomUUID();
  const userId = randomUUID();
  const foreignCustomerId = randomUUID();
  const archivedCustomerId = randomUUID();
  const stopId = randomUUID();
  let server: Server | undefined;

  await db.insert(organizationsTable).values([
    { id: organizationId, name: `Stop link ${organizationId}`, email: `${organizationId}@test.invalid` },
    { id: otherOrganizationId, name: `Other stop link ${otherOrganizationId}`, email: `${otherOrganizationId}@test.invalid` },
  ]);
  await db.insert(usersTable).values({
    id: userId,
    organizationId,
    name: "Stop link test admin",
    email: `${userId}@test.invalid`,
    role: "admin",
  });
  await db.insert(customersTable).values([
    {
      id: foreignCustomerId,
      organizationId: otherOrganizationId,
      name: "Foreign customer",
    },
    {
      id: archivedCustomerId,
      organizationId,
      name: "Archived customer",
      archivedAt: new Date(),
    },
  ]);
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    address: "Existing stop",
    latitude: 59.3293,
    longitude: 18.0686,
    status: "pending",
    serviceDurationMin: 15,
  });

  try {
    const { token } = await createSession({
      userId,
      organizationId,
      userAgent: "stop-customer-links-request-test",
    });
    server = createServer(app);
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const baseUrl = `http://127.0.0.1:${address.port}`;
    const request = async (path: string, method: string, body: unknown) => {
      const response = await fetch(`${baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          connection: "close",
        },
        body: JSON.stringify(body),
      });
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    };

    const foreignCreate = await request("/api/stops", "POST", {
      organizationId,
      customerId: foreignCustomerId,
      address: "Foreign customer stop",
      latitude: 59.3293,
      longitude: 18.0686,
      planningDate: "2026-08-26T00:00:00.000Z",
    });
    assert.equal(foreignCreate.status, 422, JSON.stringify(foreignCreate.body));

    const archivedCreate = await request("/api/stops", "POST", {
      organizationId,
      customerId: archivedCustomerId,
      address: "Archived customer stop",
      latitude: 59.3293,
      longitude: 18.0686,
      planningDate: "2026-08-26T00:00:00.000Z",
    });
    assert.equal(archivedCreate.status, 422, JSON.stringify(archivedCreate.body));

    const foreignUpdate = await request(`/api/stops/${stopId}`, "PUT", {
      customerId: foreignCustomerId,
    });
    assert.equal(foreignUpdate.status, 422, JSON.stringify(foreignUpdate.body));

    const foreignImport = await request("/api/stops/import", "POST", {
      organizationId,
      expectedRowCount: 1,
      stops: [{
        customerId: foreignCustomerId,
        planningDate: "2026-08-26T00:00:00.000Z",
        address: "Imported foreign customer stop",
        latitude: 59.3293,
        longitude: 18.0686,
      }],
    });
    assert.equal(foreignImport.status, 422, JSON.stringify(foreignImport.body));
    const persisted = await db
      .select({ id: stopsTable.id })
      .from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId));
    assert.deepEqual(persisted.map((stop) => stop.id), [stopId]);
  } finally {
    if (server) {
      await new Promise<void>((resolve, reject) =>
        server!.close((error) => (error ? reject(error) : resolve())));
    }
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(customersTable).where(
      inArray(customersTable.organizationId, [organizationId, otherOrganizationId]),
    );
    await db.delete(sessionsTable).where(eq(sessionsTable.organizationId, organizationId));
    await db.delete(usersTable).where(eq(usersTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(
      inArray(organizationsTable.id, [organizationId, otherOrganizationId]),
    );
  }
});

test("preoptimization materializes an undated customer snapshot before node evaluation", async () => {
  const organizationId = randomUUID();
  const customerId = randomUUID();
  const stopId = randomUUID();
  const planningDate = new Date("2026-08-26T00:00:00.000Z");
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: `Preoptimization ${organizationId}`,
    email: `${organizationId}@test.invalid`,
  });
  await db.insert(customersTable).values({
    id: customerId,
    organizationId,
    name: "Closure customer",
    unavailablePeriods: [{ weekday: 3, start: "08:00", end: "09:00" }],
  });
  await db.insert(stopsTable).values({
    id: stopId,
    organizationId,
    customerId,
    address: "Closure customer stop",
    latitude: 59.3293,
    longitude: 18.0686,
    status: "pending",
    serviceDurationMin: 90,
  });
  try {
    const [hydrated] = await materializeUnplannedCustomerStopSnapshots(
      organizationId,
      planningDate,
      [stopId],
    );
    assert.ok(hydrated);
    assert.equal(hydrated.planningDate?.toISOString(), planningDate.toISOString());
    assert.equal(hydrated.unavailablePeriods.length, 1);
    const node = toAlnsNode(hydrated, normalizePlanningInputs(null));
    const evaluation = evaluateRouteWorkday(
      [node],
      {
        id: "preoptimization-vehicle",
        vehicleType: "fossil",
        capacityKg: 1_000,
        capacityVolume: 10,
        rangeKm: null,
        startLatitude: 59.3293,
        startLongitude: 18.0686,
        endLatitude: 59.3293,
        endLongitude: 18.0686,
      },
      59.3293,
      18.0686,
      planningDate,
      {
        vehicleId: "preoptimization-vehicle",
        driverName: "Preoptimization driver",
        maxDrivingHoursPerDay: 8,
        avoidNightDriving: false,
        breakFrequencyMinutes: 240,
        preferredBreakDurationMin: 30,
        preferredStartTime: "07:00",
        preferredEndTime: "16:00",
      },
    );
    assert.equal(evaluation.feasible, true);
    assert.ok(evaluation.events.some((event) => event.type === "waiting"));
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(customersTable).where(eq(customersTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});