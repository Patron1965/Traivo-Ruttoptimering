import { captureSyntheticDispatch, discardSyntheticDispatch } from "./testing/capture-synthetic-dispatch";
// This focused test imports ws.ts directly rather than the HTTP app/index.
// Keep its environment self-contained for direct `tsx --test` execution.
process.env.PORT ??= "3000";
process.env.NODE_ENV ??= "test";

import assert from "node:assert/strict";
import { once } from "node:events";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { WebSocket, WebSocketServer } from "ws";
import { test } from "node:test";
import { eq, inArray } from "drizzle-orm";
import {
  db,
  driversTable,
  geofenceEventsTable,
  notificationsTable,
  organizationsTable,
  routesTable,
  sessionsTable,
  stopsTable,
  usersTable,
  vehiclesTable,
} from "@workspace/db";
import { createSession } from "./lib/session";
import { setRealPosition } from "./services/real-positions";
import {
  broadcastPositions,
  setupWebSocket,
} from "./ws";

type SocketClient = {
  socket: WebSocket;
  messages: Array<{ type?: string; data?: unknown }>;
};

async function connect(
  port: number,
  token: string,
): Promise<SocketClient> {
  const messages: SocketClient["messages"] = [];
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("WS subscribe timed out")), 5_000);
    socket.on("open", () => socket.send(JSON.stringify({ type: "subscribe" })));
    socket.on("message", (raw) => {
      const message = JSON.parse(raw.toString()) as SocketClient["messages"][number];
      messages.push(message);
      if (message.type === "subscribed") {
        clearTimeout(timeout);
        resolve();
      }
    });
    socket.on("error", reject);
  });
  return { socket, messages };
}

function positionMessage(client: SocketClient) {
  return client.messages.find((message) => message.type === "vehicles:positions");
}

async function waitForPositionMessage(client: SocketClient) {
  const existing = positionMessage(client);
  if (existing) return existing;
  return new Promise<SocketClient["messages"][number]>((resolve) => {
    const onMessage = (raw: Buffer) => {
      const message = JSON.parse(raw.toString()) as SocketClient["messages"][number];
      if (message.type !== "vehicles:positions") return;
      client.socket.off("message", onMessage);
      resolve(message);
    };
    client.socket.on("message", onMessage);
  });
}

test("WS tracking is telemetry-only and projects positions per authenticated driver", async () => {
  const organizationId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const vehicleIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const driverIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const userIds = {
    driverOne: randomUUID(),
    driverTwo: randomUUID(),
    dispatcher: randomUUID(),
    viewer: randomUUID(),
    foreignDriver: randomUUID(),
  };
  const routeIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const stopIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID()];
  const organizationIds = [organizationId, foreignOrganizationId];
  let server: Server | undefined;
  let wss: WebSocketServer | undefined;
  const clients: SocketClient[] = [];

  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: `WS tracking ${organizationId}`,
      email: `${organizationId}@ws-tracking.test`,
    },
    {
      id: foreignOrganizationId,
      name: `WS tracking foreign ${foreignOrganizationId}`,
      email: `${foreignOrganizationId}@ws-tracking.test`,
    },
  ]);

  try {
    await db.insert(vehiclesTable).values([
      ...vehicleIds.slice(0, 3).map((id, index) => ({
        id,
        organizationId,
        name: `WS vehicle ${index + 1}`,
        licensePlate: `WS-${id.slice(0, 8)}`,
      })),
      {
        id: vehicleIds[3],
        organizationId: foreignOrganizationId,
        name: "WS foreign vehicle",
        licensePlate: `WS-${vehicleIds[3].slice(0, 8)}`,
      },
    ]);
    await db.insert(driversTable).values([
      ...driverIds.slice(0, 3).map((id, index) => ({
        id,
        organizationId,
        vehicleId: vehicleIds[index],
        name: `WS driver ${index + 1}`,
      })),
      {
        id: driverIds[3],
        organizationId: foreignOrganizationId,
        vehicleId: vehicleIds[3],
        name: "WS foreign driver",
      },
    ]);
    await db.insert(usersTable).values([
      {
        id: userIds.driverOne,
        organizationId,
        name: "WS driver one",
        email: `${userIds.driverOne}@ws-tracking.test`,
        role: "driver",
        driverProfileId: driverIds[0],
      },
      {
        id: userIds.driverTwo,
        organizationId,
        name: "WS driver two",
        email: `${userIds.driverTwo}@ws-tracking.test`,
        role: "driver",
        driverProfileId: driverIds[1],
      },
      {
        id: userIds.dispatcher,
        organizationId,
        name: "WS dispatcher",
        email: `${userIds.dispatcher}@ws-tracking.test`,
        role: "dispatcher",
      },
      {
        id: userIds.viewer,
        organizationId,
        name: "WS viewer",
        email: `${userIds.viewer}@ws-tracking.test`,
        role: "viewer",
      },
      {
        id: userIds.foreignDriver,
        organizationId: foreignOrganizationId,
        name: "WS foreign driver",
        email: `${userIds.foreignDriver}@ws-tracking.test`,
        role: "driver",
        driverProfileId: driverIds[3],
      },
    ]);
    await db.insert(routesTable).values([
      {
        id: routeIds[0],
        organizationId,
        vehicleId: vehicleIds[0],
        name: "WS route one",
        status: "in_progress",
        planRevision: 4,
        handoffStatus: "accepted",
        handoffVersion: 4,
        handoffDriverId: driverIds[0],
        date: new Date(),
      },
      {
        id: routeIds[1],
        organizationId,
        vehicleId: vehicleIds[1],
        name: "WS sibling route",
        status: "in_progress",
        planRevision: 5,
        handoffStatus: "accepted",
        handoffVersion: 5,
        handoffDriverId: driverIds[1],
        date: new Date(),
      },
      {
        id: routeIds[2],
        organizationId,
        vehicleId: vehicleIds[2],
        name: "WS accepted but no GPS",
        status: "in_progress",
        planRevision: 6,
        handoffStatus: "accepted",
        handoffVersion: 6,
        handoffDriverId: driverIds[2],
        createdAt: new Date(),
        date: new Date(),
      },
      {
        id: routeIds[3],
        organizationId: foreignOrganizationId,
        vehicleId: vehicleIds[3],
        name: "WS foreign route",
        status: "in_progress",
        planRevision: 7,
        handoffStatus: "accepted",
        handoffVersion: 7,
        handoffDriverId: driverIds[3],
        date: new Date(),
      },
    ]);
    await db.insert(stopsTable).values([
      {
        id: stopIds[0],
        organizationId,
        routeId: routeIds[0],
        sequenceOrder: 1,
        address: "WS customer one",
        latitude: 59.5,
        longitude: 18.3,
        status: "pending",
      },
      {
        id: stopIds[1],
        organizationId,
        routeId: routeIds[1],
        sequenceOrder: 1,
        address: "WS sibling customer",
        latitude: 59.6,
        longitude: 18.4,
        status: "pending",
      },
      {
        id: stopIds[2],
        organizationId,
        routeId: routeIds[2],
        sequenceOrder: 1,
        address: "WS no GPS customer",
        latitude: 59.3293,
        longitude: 18.0686,
        status: "pending",
      },
      {
        id: stopIds[3],
        organizationId: foreignOrganizationId,
        routeId: routeIds[3],
        sequenceOrder: 1,
        address: "WS foreign customer",
        latitude: 59.7,
        longitude: 18.5,
        status: "pending",
      },
    ]);

    await captureSyntheticDispatch(organizationId, routeIds.slice(0, 3));
    await captureSyntheticDispatch(foreignOrganizationId, [routeIds[3]]);
    const now = Date.now();
    setRealPosition(vehicleIds[0], {
      latitude: 59.1,
      longitude: 18.1,
      heading: 90,
      speedKmh: 30,
      timestamp: now,
    });
    setRealPosition(vehicleIds[1], {
      latitude: 59.2,
      longitude: 18.2,
      heading: 180,
      speedKmh: 20,
      timestamp: now,
    });
    setRealPosition(vehicleIds[3], {
      latitude: 59.3,
      longitude: 18.0,
      heading: 270,
      speedKmh: 25,
      timestamp: now,
    });

    const [beforeRoute] = await db
      .select({ status: routesTable.status, planRevision: routesTable.planRevision })
      .from(routesTable)
      .where(eq(routesTable.id, routeIds[2]));
    const [beforeStop] = await db
      .select({ status: stopsTable.status, terminalAt: stopsTable.terminalAt })
      .from(stopsTable)
      .where(eq(stopsTable.id, stopIds[2]));
    const beforeGeofenceCount = (await db
      .select({ id: geofenceEventsTable.id })
      .from(geofenceEventsTable)
      .where(eq(geofenceEventsTable.organizationId, organizationId))).length;
    const beforeNotificationCount = (await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(eq(notificationsTable.organizationId, organizationId))).length;

    server = createServer();
    wss = setupWebSocket(server, { startBroadcasts: false });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const { port } = server.address() as AddressInfo;
    const sessionTokens = await Promise.all([
      createSession({ userId: userIds.driverOne, organizationId, userAgent: "ws-tracking-test" }),
      createSession({ userId: userIds.driverTwo, organizationId, userAgent: "ws-tracking-test" }),
      createSession({ userId: userIds.dispatcher, organizationId, userAgent: "ws-tracking-test" }),
      createSession({ userId: userIds.viewer, organizationId, userAgent: "ws-tracking-test" }),
      createSession({ userId: userIds.foreignDriver, organizationId: foreignOrganizationId, userAgent: "ws-tracking-test" }),
    ]);
    for (const session of sessionTokens) clients.push(await connect(port, session.token));

    await broadcastPositions();

    const positionMessages = await Promise.all(clients.map(waitForPositionMessage));
    const driverOnePositions = positionMessages[0].data as Array<Record<string, unknown>>;
    const driverTwoPositions = positionMessages[1].data as Array<Record<string, unknown>>;
    const dispatcherPositions = positionMessages[2].data as Array<Record<string, unknown>>;
    const viewerPositions = positionMessages[3].data as Array<Record<string, unknown>>;
    const foreignDriverPositions = positionMessages[4].data as Array<Record<string, unknown>>;
    assert.deepEqual(driverOnePositions.map((position) => position.routeId), [routeIds[0]]);
    assert.equal(driverOnePositions[0].measuredAt, new Date(now).toISOString());
    assert.deepEqual(driverTwoPositions.map((position) => position.routeId), [routeIds[1]]);
    assert.deepEqual(
      dispatcherPositions.map((position) => position.routeId).sort(),
      routeIds.slice(0, 2).sort(),
    );
    assert.deepEqual(viewerPositions.map((position) => position.routeId).sort(), routeIds.slice(0, 2).sort());
    assert.equal(viewerPositions.every((position) => position.nextStopAddress === null), true);
    assert.deepEqual(foreignDriverPositions.map((position) => position.routeId), [routeIds[3]]);

    const [afterRoute] = await db
      .select({ status: routesTable.status, planRevision: routesTable.planRevision })
      .from(routesTable)
      .where(eq(routesTable.id, routeIds[2]));
    const [afterStop] = await db
      .select({ status: stopsTable.status, terminalAt: stopsTable.terminalAt })
      .from(stopsTable)
      .where(eq(stopsTable.id, stopIds[2]));
    const afterGeofenceCount = (await db
      .select({ id: geofenceEventsTable.id })
      .from(geofenceEventsTable)
      .where(eq(geofenceEventsTable.organizationId, organizationId))).length;
    const afterNotificationCount = (await db
      .select({ id: notificationsTable.id })
      .from(notificationsTable)
      .where(eq(notificationsTable.organizationId, organizationId))).length;
    assert.deepEqual(afterRoute, beforeRoute);
    assert.deepEqual(afterStop, beforeStop);
    assert.equal(afterGeofenceCount, beforeGeofenceCount);
    assert.equal(afterNotificationCount, beforeNotificationCount);
  } finally {
    for (const client of clients) client.socket.terminate();
    if (wss) {
      await new Promise<void>((resolve) => wss!.close(() => resolve()));
    }
    if (server) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server!.close(() => resolve()));
    }
    await db.delete(notificationsTable).where(inArray(notificationsTable.organizationId, organizationIds));
    await db.delete(geofenceEventsTable).where(inArray(geofenceEventsTable.organizationId, organizationIds));
    await discardSyntheticDispatch(organizationId, routeIds.slice(0, 3));
    await discardSyntheticDispatch(foreignOrganizationId, [routeIds[3]]);
    await db.delete(stopsTable).where(inArray(stopsTable.id, stopIds));
    await db.delete(routesTable).where(inArray(routesTable.id, routeIds));
    await db.delete(sessionsTable).where(inArray(sessionsTable.userId, Object.values(userIds)));
    await db.delete(usersTable).where(inArray(usersTable.id, Object.values(userIds)));
    await db.delete(driversTable).where(inArray(driversTable.id, driverIds));
    await db.delete(vehiclesTable).where(inArray(vehiclesTable.id, vehicleIds));
    await db.delete(organizationsTable).where(inArray(organizationsTable.id, organizationIds));
  }
});