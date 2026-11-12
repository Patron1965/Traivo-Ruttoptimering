import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express from "express";
import { eq } from "drizzle-orm";
import {
  db, organizationsTable, usersTable, vehiclesTable, driversTable, routesTable,
  stopsTable, routeDispatchSnapshotsTable, stopMessageThreadsTable,
  stopMessagesTable, stopMessageReadReceiptsTable, vehiclePositionsTable,
  routeMessagesTable,
} from "@workspace/db";
import { listStopMessages, sendStopMessage, listRouteMessages, sendRouteMessage } from "../services/stop-message-service";
import type { AuthUser } from "../middleware/auth";
import trackingRouter from "./tracking";

test("working moves preserve two-way chat; withdrawn dispatch never breaks another vehicle's GPS", async () => {
  const org = randomUUID(), vehicle = randomUUID(), driver = randomUUID(), route = randomUUID();
  const stop = randomUUID(), plannerUser = randomUUID(), driverUser = randomUUID();
  const withdrawn = randomUUID();
  const planner = { organizationId: org, userId: plannerUser, role: "dispatcher", driverProfileId: null };
  const recipient = { organizationId: org, userId: driverUser, role: "driver", driverProfileId: driver };
  try {
    await db.insert(organizationsTable).values({ id: org, name: "Isolated communication test", email: `${org}@fixture.invalid` });
    await db.insert(vehiclesTable).values({ id: vehicle, organizationId: org, name: "Test", licensePlate: "TEST" });
    await db.insert(driversTable).values({ id: driver, organizationId: org, name: "Test", vehicleId: vehicle });
    await db.insert(usersTable).values([
      { id: plannerUser, organizationId: org, name: "Planner", email: `${plannerUser}@fixture.invalid`, role: "dispatcher" },
      { id: driverUser, organizationId: org, name: "Driver", email: `${driverUser}@fixture.invalid`, role: "driver" },
    ]);
    const [original] = await db.insert(routesTable).values({
      id: route, organizationId: org, vehicleId: vehicle, name: "Current dispatch", date: new Date(),
      status: "in_progress", planRevision: 0, dispatchSnapshotVersion: 0,
      handoffVersion: 0, handoffDriverId: driver, handoffStatus: "accepted", totalStops: 1,
    }).returning();
    const [originalStop] = await db.insert(stopsTable).values({
      id: stop, organizationId: org, routeId: route, address: "Synthetic test stop",
      latitude: 59.3, longitude: 18.1, sequenceOrder: 1,
    }).returning();
    await db.insert(routeDispatchSnapshotsTable).values({
      routeId: route, organizationId: org, planRevision: 0, driverId: driver,
      capturedAt: new Date(), route: { ...original, __snapshotSchema: 2 }, stops: [originalStop],
    });
    await sendStopMessage({ stopId: stop, actor: planner, body: "Before working edit", clientMessageId: randomUUID() });
    await db.update(routesTable).set({ planRevision: 1 }).where(eq(routesTable.id, route));
    await db.update(stopsTable).set({ routeId: null }).where(eq(stopsTable.id, stop));
    assert.equal((await listStopMessages(stop, recipient)).messages.length, 1);
    await sendStopMessage({ stopId: stop, actor: recipient, body: "Driver response", clientMessageId: randomUUID() });
    await sendStopMessage({ stopId: stop, actor: planner, body: "Planner response", clientMessageId: randomUUID() });
    assert.equal((await listStopMessages(stop, planner)).messages.length, 3);
    assert.equal((await listStopMessages(stop, recipient)).messages.length, 3);
    await db.insert(routeMessagesTable).values(Array.from({ length: 201 }, (_, index) => ({
      organizationId: org, routeId: route, senderUserId: plannerUser, senderRole: "dispatcher",
      clientMessageId: randomUUID(), body: `Earlier message ${index}`,
      createdAt: new Date(Date.now() - 600_000 + index * 100),
    })));
    await sendRouteMessage({ routeId: route, actor: recipient, body: "Latest driver route message", clientMessageId: randomUUID() });
    await sendRouteMessage({ routeId: route, actor: planner, body: "Latest planner route message", clientMessageId: randomUUID() });
    const plannerChat = await listRouteMessages(route, planner);
    const driverChat = await listRouteMessages(route, recipient);
    assert.equal(plannerChat.messages.length, 200);
    assert.equal(plannerChat.messages.at(-1)?.body, "Latest planner route message");
    assert.equal(driverChat.messages.at(-2)?.body, "Latest driver route message");
    await assert.rejects(listRouteMessages(route, { ...recipient, driverProfileId: randomUUID() }));
    await assert.rejects(listStopMessages(stop, { ...planner, organizationId: randomUUID() }));
    await assert.rejects(listStopMessages(stop, { ...recipient, driverProfileId: randomUUID() }));
    await assert.rejects(listStopMessages(stop, { ...planner, role: "viewer" }));
    // A previous recipient's thread must never be exposed to the current one.
    const previousDriver = randomUUID();
    await db.insert(driversTable).values({ id: previousDriver, organizationId: org, name: "Previous recipient" });
    await db.update(stopMessageThreadsTable).set({ driverId: previousDriver })
      .where(eq(stopMessageThreadsTable.organizationId, org));
    await assert.rejects(listStopMessages(stop, recipient), /thread changed/);
    await db.update(stopMessageThreadsTable).set({ driverId: driver })
      .where(eq(stopMessageThreadsTable.organizationId, org));

    await db.insert(routesTable).values({
      id: withdrawn, organizationId: org, vehicleId: vehicle, name: "Cleared old handoff",
      date: new Date(), status: "in_progress", dispatchSnapshotVersion: 0,
      handoffVersion: null, handoffDriverId: null, handoffStatus: "pending",
    });
    await db.insert(vehiclePositionsTable).values({
      organizationId: org, vehicleId: vehicle, routeId: route, latitude: 59.31,
      longitude: 18.12, recordedAt: new Date(),
    });
    const app = express();
    app.use((req, _res, next) => {
      req.user = { id: plannerUser, organizationId: org, role: "dispatcher", driverProfileId: null } as AuthUser;
      next();
    });
    app.use(trackingRouter);
    const server = app.listen(0);
    await once(server, "listening");
    try {
      const response = await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/vehicles/positions`);
      assert.equal(response.status, 200, await response.clone().text());
      const positions = await response.json() as Array<{ routeId: string; isRealGps: boolean; latitude: number }>;
      assert.deepEqual(positions.map((position: { routeId: string }) => position.routeId), [route]);
      assert.equal(positions[0].isRealGps, true);
      assert.equal(positions[0].latitude, 59.31);
    } finally {
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  } finally {
    await db.delete(routeMessagesTable).where(eq(routeMessagesTable.organizationId, org));
    await db.delete(stopMessageReadReceiptsTable).where(eq(stopMessageReadReceiptsTable.organizationId, org));
    await db.delete(stopMessagesTable).where(eq(stopMessagesTable.organizationId, org));
    await db.delete(stopMessageThreadsTable).where(eq(stopMessageThreadsTable.organizationId, org));
    await db.delete(vehiclePositionsTable).where(eq(vehiclePositionsTable.organizationId, org));
    await db.delete(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.organizationId, org));
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, org));
    await db.delete(routesTable).where(eq(routesTable.organizationId, org));
    await db.delete(usersTable).where(eq(usersTable.organizationId, org));
    await db.delete(driversTable).where(eq(driversTable.organizationId, org));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, org));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, org));
  }
});
