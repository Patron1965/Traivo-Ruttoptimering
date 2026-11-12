import { captureSyntheticDispatch, discardSyntheticDispatch } from "./testing/capture-synthetic-dispatch";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { createServer, type Server } from "node:http";
import { after, before, test } from "node:test";
import {
  db,
  auditLogTable,
  deliveryProofsTable,
  driversTable,
  executionEventsTable,
  organizationsTable,
  pool,
  routesTable,
  sessionsTable,
  stopsTable,
  usersTable,
  vehiclesTable,
} from "@workspace/db";
import { and, asc, eq, inArray } from "drizzle-orm";
import { WebSocket, WebSocketServer } from "ws";
import { createSession } from "./lib/session";
import {
  setAfterLockedExecutionValidationHookForTests,
  setBeforeLockedExecutionValidationHookForTests,
} from "./services/execution-event-service";
import {
  lockAndValidateReoptimizationSnapshot,
  ReoptimizationSnapshotConflictError,
} from "./services/reoptimization-lock-service";
import { setupWebSocket, transitionGeofenceStopStatus } from "./ws";

const organizationId = randomUUID();
const vehicleId = randomUUID();
const driverProfileId = randomUUID();
const routeId = randomUUID();
const stopIds = [randomUUID(), randomUUID(), randomUUID(), randomUUID(), randomUUID()];
const stalePlanGeofenceStopId = randomUUID();
const reoptimizationRaceStopId = randomUUID();
const userIds = {
  driver: randomUUID(),
  admin: randomUUID(),
  viewer: randomUUID(),
  dispatcherOne: randomUUID(),
  dispatcherTwo: randomUUID(),
};
const tokens: Record<keyof typeof userIds, string> = {
  driver: "",
  admin: "",
  viewer: "",
  dispatcherOne: "",
  dispatcherTwo: "",
};

let server: Server;
let wss: WebSocketServer;
let baseUrl = "";

type SocketClient = {
  socket: WebSocket;
  messages: Array<{ type?: string; data?: Record<string, unknown> }>;
};

async function apiRequest(
  actor: keyof typeof tokens,
  path: string,
  init: RequestInit = {},
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${tokens[actor]}`);
  headers.set("Connection", "close");
  if (init.body && !headers.has("Content-Type")) headers.set("Content-Type", "application/json");
  return fetch(`${baseUrl}${path}`, { ...init, headers });
}

async function connectDispatcher(actor: "dispatcherOne" | "dispatcherTwo"): Promise<SocketClient> {
  const messages: SocketClient["messages"] = [];
  const socket = new WebSocket(`${baseUrl.replace(/^http/, "ws")}/ws`, {
    headers: { Authorization: `Bearer ${tokens[actor]}` },
  });
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error(`${actor} websocket subscribe timed out`)), 10_000);
    socket.on("open", () => {
      socket.send(JSON.stringify({ type: "subscribe", organizationId }));
    });
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

async function waitFor(
  predicate: () => boolean,
  description: string,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function closeSocket(socket: WebSocket): Promise<void> {
  if (socket.readyState === WebSocket.CLOSED) return;
  await new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.terminate();
  });
}

function executionMessages(client: SocketClient) {
  return client.messages.filter((message) => message.type === "execution:event");
}

before(async () => {
  await db.insert(organizationsTable).values({
    id: organizationId,
    name: `Execution realtime ${organizationId}`,
    email: `${organizationId}@example.test`,
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Realtime vehicle",
    licensePlate: `RT-${organizationId.slice(0, 6)}`,
  });
  await db.insert(driversTable).values({
    id: driverProfileId,
    organizationId,
    vehicleId,
    name: "Realtime driver",
  });
  await db.insert(usersTable).values([
    {
      id: userIds.driver,
      organizationId,
      name: "Realtime driver user",
      email: `${userIds.driver}@example.test`,
      role: "driver",
      driverProfileId,
    },
    {
      id: userIds.admin,
      organizationId,
      name: "Realtime assisting admin",
      email: `${userIds.admin}@example.test`,
      role: "admin",
    },
    {
      id: userIds.viewer,
      organizationId,
      name: "Realtime viewer",
      email: `${userIds.viewer}@example.test`,
      role: "viewer",
    },
    {
      id: userIds.dispatcherOne,
      organizationId,
      name: "Realtime dispatcher one",
      email: `${userIds.dispatcherOne}@example.test`,
      role: "dispatcher",
    },
    {
      id: userIds.dispatcherTwo,
      organizationId,
      name: "Realtime dispatcher two",
      email: `${userIds.dispatcherTwo}@example.test`,
      role: "dispatcher",
    },
  ]);

  const timelineStart = new Date(Date.now() - 15 * 60_000);
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    vehicleId,
    name: "Realtime route",
    date: timelineStart,
    status: "in_progress",
    planRevision: 4,
    handoffVersion: 4,
    handoffStatus: "accepted",
    handoffDriverId: driverProfileId,
    workdayTimeline: [
      {
        type: "service",
        stopId: stopIds[0],
        startAt: timelineStart.toISOString(),
        endAt: new Date(timelineStart.getTime() + 10 * 60_000).toISOString(),
        durationMin: 10,
      },
      {
        type: "service",
        stopId: stopIds[1],
        startAt: new Date(timelineStart.getTime() + 20 * 60_000).toISOString(),
        endAt: new Date(timelineStart.getTime() + 30 * 60_000).toISOString(),
        durationMin: 10,
      },
      {
        type: "service",
        stopId: stopIds[2],
        startAt: new Date(timelineStart.getTime() + 40 * 60_000).toISOString(),
        endAt: new Date(timelineStart.getTime() + 50 * 60_000).toISOString(),
        durationMin: 10,
      },
      {
        type: "return",
        startAt: new Date(timelineStart.getTime() + 50 * 60_000).toISOString(),
        endAt: new Date(timelineStart.getTime() + 65 * 60_000).toISOString(),
        durationMin: 15,
      },
      {
        type: "depot_end",
        startAt: new Date(timelineStart.getTime() + 65 * 60_000).toISOString(),
        endAt: new Date(timelineStart.getTime() + 70 * 60_000).toISOString(),
        durationMin: 5,
      },
    ],
    workdaySummary: {
      shiftMin: 480,
      nonReturnDrivingMin: 15,
      serviceMin: 30,
      waitingMin: 0,
      breakMin: 0,
      returnMin: 15,
      totalMin: 70,
      marginMin: 410,
      overtimeMin: 0,
      shiftEndAt: new Date(timelineStart.getTime() + 480 * 60_000).toISOString(),
    },
  });
  await db.insert(stopsTable).values(stopIds.map((id, index) => ({
    id,
    organizationId,
    routeId,
    address: `Realtime stop ${index + 1}`,
    latitude: 59.3293 + index * 0.001,
    longitude: 18.0686 + index * 0.001,
    status: index === 2 ? "in_progress" as const : "pending" as const,
    sequenceOrder: index,
    serviceDurationMin: 10,
  })));

  await db.insert(stopsTable).values([
    { id: stalePlanGeofenceStopId, organizationId, routeId, address: "Stale plan geofence stop", latitude: 59.41, longitude: 18.11, status: "pending", sequenceOrder: 98, serviceDurationMin: 10 },
    { id: reoptimizationRaceStopId, organizationId, routeId, address: "Reoptimization race stop", latitude: 59.4, longitude: 18.1, status: "pending", sequenceOrder: 99, serviceDurationMin: 10 },
  ]);
  await captureSyntheticDispatch(organizationId, [routeId]);
  for (const actor of Object.keys(userIds) as Array<keyof typeof userIds>) {
    const session = await createSession({
      userId: userIds[actor],
      organizationId,
      userAgent: "execution-realtime-request-test",
    });
    tokens[actor] = session.token;
  }

  const { default: app } = await import("./app");
  server = createServer(app);
  wss = setupWebSocket(server, { startBroadcasts: false });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  baseUrl = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  for (const client of wss?.clients ?? []) client.terminate();
  await Promise.race([
    new Promise<void>((resolve) => wss?.close(() => resolve())),
    new Promise<void>((resolve) => setTimeout(resolve, 1_000)),
  ]);
  server?.closeAllConnections();
  await new Promise<void>((resolve, reject) =>
    server?.close((error) => error ? reject(error) : resolve()),
  );

  await db.delete(deliveryProofsTable).where(inArray(deliveryProofsTable.stopId, stopIds));
  await db.delete(auditLogTable).where(eq(auditLogTable.organizationId, organizationId));
  await db.delete(executionEventsTable).where(eq(executionEventsTable.organizationId, organizationId));
  await discardSyntheticDispatch(organizationId, [routeId]);
  await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
  await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
  await db.delete(sessionsTable).where(eq(sessionsTable.organizationId, organizationId));
  await db.delete(usersTable).where(eq(usersTable.organizationId, organizationId));
  await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
  await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
  await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  await pool.end();
});

test("driver offline events reach two dispatchers once, in order, after reconnect", async () => {
  const dispatcherOne = await connectDispatcher("dispatcherOne");
  let dispatcherTwo = await connectDispatcher("dispatcherTwo");

  const completedAt = new Date().toISOString();
  const completedEvent = {
    clientEventId: `completed-${randomUUID()}`,
    type: "completed",
    planVersion: 4,
    occurredAt: completedAt,
    actualDurationMin: 18,
    comment: "Leveransen tog längre tid än planerat",
  };
  const completed = await apiRequest("driver", `/api/stops/${stopIds[0]}/execution-events`, {
    method: "POST",
    body: JSON.stringify(completedEvent),
  });
  assert.equal(completed.status, 201, await completed.clone().text());
  await waitFor(
    () => executionMessages(dispatcherOne).length === 1 && executionMessages(dispatcherTwo).length === 1,
    "both dispatchers to receive completion",
  );

  const onlineFailedEvent = {
    clientEventId: `failed-online-${randomUUID()}`,
    type: "failed",
    planVersion: 4,
    occurredAt: new Date(Date.now() + 500).toISOString(),
    comment: "Misslyckades medan föraren var online",
  };
  const onlineFailed = await apiRequest("driver", `/api/stops/${stopIds[3]}/execution-events`, {
    method: "POST",
    body: JSON.stringify(onlineFailedEvent),
  });
  assert.equal(onlineFailed.status, 201, await onlineFailed.clone().text());
  await waitFor(
    () => executionMessages(dispatcherOne).length === 2 && executionMessages(dispatcherTwo).length === 2,
    "both dispatchers to receive online failure",
  );

  await closeSocket(dispatcherTwo.socket);
  const offlineQueue = [
    {
      kind: "proof" as const,
      stopId: stopIds[0],
      body: {
        proofType: "barcode",
        data: "OFFLINE-PROOF",
        notes: "Fotoersättning med kommentar från offlinekö",
        clientEventId: `proof-${randomUUID()}`,
        planVersion: 4,
        occurredAt: new Date(Date.now() + 1_000).toISOString(),
      },
    },
    {
      kind: "execution" as const,
      stopId: stopIds[1],
      body: {
        clientEventId: `skipped-${randomUUID()}`,
        type: "skipped",
        planVersion: 4,
        occurredAt: new Date(Date.now() + 2_000).toISOString(),
        skipReason: "CUSTOMER_UNAVAILABLE",
        comment: "Ingen öppnade",
      },
    },
    {
      kind: "execution" as const,
      stopId: stopIds[4],
      body: {
        clientEventId: `failed-offline-${randomUUID()}`,
        type: "failed",
        planVersion: 4,
        occurredAt: new Date(Date.now() + 3_000).toISOString(),
        comment: "Misslyckades i offlinekö",
      },
    },
  ];

  dispatcherTwo = await connectDispatcher("dispatcherTwo");
  for (const event of offlineQueue) {
    const response = await apiRequest(
      "driver",
      event.kind === "proof"
        ? `/api/stops/${event.stopId}/proof`
        : `/api/stops/${event.stopId}/execution-events`,
      { method: "POST", body: JSON.stringify(event.body) },
    );
    assert.equal(response.status, 201, await response.clone().text());
  }
  await waitFor(
    () => executionMessages(dispatcherOne).length === 5 && executionMessages(dispatcherTwo).length === 3,
    "ordered proof, skip and failure broadcasts after reconnect",
  );

  assert.deepEqual(
    executionMessages(dispatcherOne).map((message) =>
      (message.data?.event as { eventType?: string } | undefined)?.eventType
    ),
    ["completed", "failed", "proof", "skipped", "failed"],
  );
  assert.deepEqual(
    executionMessages(dispatcherTwo).map((message) =>
      (message.data?.event as { eventType?: string } | undefined)?.eventType
    ),
    ["proof", "skipped", "failed"],
  );

  for (const event of offlineQueue) {
    const duplicate = await apiRequest(
      "driver",
      event.kind === "proof"
        ? `/api/stops/${event.stopId}/proof`
        : `/api/stops/${event.stopId}/execution-events`,
      { method: "POST", body: JSON.stringify(event.body) },
    );
    assert.equal(duplicate.status, 200, await duplicate.clone().text());
  }
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(executionMessages(dispatcherOne).length, 5);
  assert.equal(executionMessages(dispatcherTwo).length, 3);

  const stale = await apiRequest("driver", `/api/stops/${stopIds[1]}/execution-events`, {
    method: "POST",
    body: JSON.stringify({
      clientEventId: `stale-${randomUUID()}`,
      type: "comment",
      planVersion: 3,
      occurredAt: new Date(Date.now() + 3_000).toISOString(),
      comment: "Ska avvisas",
    }),
  });
  assert.equal(stale.status, 409, await stale.clone().text());

  const stopsResponse = await apiRequest("dispatcherTwo", `/api/routes/${routeId}/stops`);
  assert.equal(stopsResponse.status, 200, await stopsResponse.clone().text());
  const visibleStops = await stopsResponse.json() as Array<{
    id: string;
    status: string;
    sequenceOrder: number;
    skipReason?: string | null;
    skipComment?: string | null;
    executionComment?: string | null;
  }>;
  const byId = new Map(visibleStops.map((stop) => [stop.id, stop]));
  assert.equal(byId.get(stopIds[0])?.status, "completed");
  assert.equal(byId.get(stopIds[0])?.executionComment, completedEvent.comment);
  assert.equal(byId.get(stopIds[1])?.status, "skipped");
  assert.equal(byId.get(stopIds[1])?.skipReason, "CUSTOMER_UNAVAILABLE");
  assert.equal(byId.get(stopIds[1])?.skipComment, "Ingen öppnade");
  assert.equal(byId.get(stopIds[2])?.status, "in_progress");
  assert.equal(byId.get(stopIds[3])?.status, "failed");
  assert.equal(byId.get(stopIds[3])?.executionComment, onlineFailedEvent.comment);
  assert.equal(byId.get(stopIds[4])?.status, "failed");
  assert.equal(byId.get(stopIds[4])?.executionComment, offlineQueue[2].body.comment);
  assert.deepEqual(
    visibleStops.map((stop) => [stop.id, stop.sequenceOrder]),
    [...stopIds.map((id, index) => [id, index]),
      [stalePlanGeofenceStopId, 98], [reoptimizationRaceStopId, 99]],
  );

  const proofsResponse = await apiRequest("dispatcherTwo", `/api/stops/${stopIds[0]}/proofs`);
  assert.equal(proofsResponse.status, 200, await proofsResponse.clone().text());
  const proofs = await proofsResponse.json() as Array<{ notes?: string | null }>;
  assert.equal(proofs.some((proof) => proof.notes === offlineQueue[0].body.notes), true);

  const orderedEvents = await db
    .select({
      clientEventId: executionEventsTable.clientEventId,
      occurredAt: executionEventsTable.occurredAt,
    })
    .from(executionEventsTable)
    .where(and(
      eq(executionEventsTable.organizationId, organizationId),
      eq(executionEventsTable.routeId, routeId),
    ))
    .orderBy(asc(executionEventsTable.occurredAt));
  assert.deepEqual(
    orderedEvents.map((event) => event.clientEventId),
    [
      completedEvent.clientEventId,
      onlineFailedEvent.clientEventId,
      ...offlineQueue.map((event) => event.body.clientEventId),
    ],
  );

  const concurrentProofId = `proof-concurrent-${randomUUID()}`;
  const concurrentProofBody = {
    proofType: "barcode",
    data: "CONCURRENT-PROOF",
    notes: "Samma offlinebevis skickades två gånger",
    clientEventId: concurrentProofId,
    planVersion: 4,
    occurredAt: new Date(Date.now() + 4_000).toISOString(),
  };
  const messagesBeforeConcurrentProof = executionMessages(dispatcherOne).length;
  const concurrentProofResponses = await Promise.all([
    apiRequest("driver", `/api/stops/${stopIds[2]}/proof`, {
      method: "POST",
      body: JSON.stringify(concurrentProofBody),
    }),
    apiRequest("driver", `/api/stops/${stopIds[2]}/proof`, {
      method: "POST",
      body: JSON.stringify(concurrentProofBody),
    }),
  ]);
  assert.deepEqual(
    concurrentProofResponses.map((response) => response.status).sort(),
    [200, 201],
  );
  await waitFor(
    () => executionMessages(dispatcherOne).length === messagesBeforeConcurrentProof + 1,
    "one broadcast for concurrent duplicate proof requests",
  );
  const concurrentProofRows = await db.select().from(deliveryProofsTable).where(and(
    eq(deliveryProofsTable.stopId, stopIds[2]),
    eq(deliveryProofsTable.clientEventId, concurrentProofId),
  ));
  const concurrentProofEvents = await db.select().from(executionEventsTable).where(and(
    eq(executionEventsTable.organizationId, organizationId),
    eq(executionEventsTable.clientEventId, concurrentProofId),
  ));
  assert.equal(concurrentProofRows.length, 1);
  assert.equal(concurrentProofEvents.length, 1);
  assert.equal(
    concurrentProofEvents[0]?.payload.proofId,
    concurrentProofRows[0]?.id,
  );

  const staleRaceId = `stale-race-${randomUUID()}`;
  const [stopBeforeStaleRace] = await db.select({
    status: stopsTable.status,
    executionComment: stopsTable.executionComment,
  }).from(stopsTable).where(eq(stopsTable.id, stopIds[2]));
  const messagesBeforeStaleRace = executionMessages(dispatcherOne).length;
  let staleRaceReachedHook = false;
  let releaseStaleRace!: () => void;
  const staleRaceRelease = new Promise<void>((resolve) => {
    releaseStaleRace = resolve;
  });
  setBeforeLockedExecutionValidationHookForTests(async (event) => {
    if (event.clientEventId !== staleRaceId) return;
    staleRaceReachedHook = true;
    await staleRaceRelease;
  });
  try {
    const staleRaceResponsePromise = apiRequest(
      "driver",
      `/api/stops/${stopIds[2]}/execution-events`,
      {
        method: "POST",
        body: JSON.stringify({
          clientEventId: staleRaceId,
          type: "comment",
          planVersion: 4,
          occurredAt: new Date(Date.now() + 5_000).toISOString(),
          comment: "Får inte sparas mot gammal plan",
        }),
      },
    );
    await waitFor(() => staleRaceReachedHook, "execution event pre-lock barrier");
    await db.update(routesTable).set({
      planRevision: 5,
      handoffVersion: 5,
    }).where(and(
      eq(routesTable.id, routeId),
      eq(routesTable.organizationId, organizationId),
    ));
    // An actual outgoing replacement, not merely a new working proposal,
    // invalidates a queued event for version 4.
    await captureSyntheticDispatch(organizationId, [routeId]);
    releaseStaleRace();
    const staleRaceResponse = await staleRaceResponsePromise;
    assert.equal(staleRaceResponse.status, 409, await staleRaceResponse.clone().text());
  } finally {
    releaseStaleRace();
    setBeforeLockedExecutionValidationHookForTests(null);
    await db.update(routesTable).set({
      planRevision: 4,
      dispatchSnapshotVersion: 4,
      handoffVersion: 4,
      handoffStatus: "accepted",
      handoffDriverId: driverProfileId,
    }).where(and(
      eq(routesTable.id, routeId),
      eq(routesTable.organizationId, organizationId),
    ));
  }
  const [stopAfterStaleRace] = await db.select({
    status: stopsTable.status,
    executionComment: stopsTable.executionComment,
  }).from(stopsTable).where(eq(stopsTable.id, stopIds[2]));
  const staleRaceEvents = await db.select().from(executionEventsTable).where(and(
    eq(executionEventsTable.organizationId, organizationId),
    eq(executionEventsTable.clientEventId, staleRaceId),
  ));
  assert.deepEqual(stopAfterStaleRace, stopBeforeStaleRace);
  assert.equal(staleRaceEvents.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(executionMessages(dispatcherOne).length, messagesBeforeStaleRace);

  const reassignedProofId = `proof-reassigned-${randomUUID()}`;
  const messagesBeforeReassignedProof = executionMessages(dispatcherOne).length;
  let reassignedProofReachedHook = false;
  let releaseReassignedProof!: () => void;
  const reassignedProofRelease = new Promise<void>((resolve) => {
    releaseReassignedProof = resolve;
  });
  setBeforeLockedExecutionValidationHookForTests(async (event) => {
    if (event.clientEventId !== reassignedProofId) return;
    reassignedProofReachedHook = true;
    await reassignedProofRelease;
  });
  try {
    const reassignedProofResponsePromise = apiRequest(
      "driver",
      `/api/stops/${stopIds[2]}/proof`,
      {
        method: "POST",
        body: JSON.stringify({
          proofType: "barcode",
          data: "MUST-NOT-PERSIST",
          notes: "Föraren byttes efter första kontrollen",
          clientEventId: reassignedProofId,
          planVersion: 4,
          occurredAt: new Date(Date.now() + 6_000).toISOString(),
        }),
      },
    );
    await waitFor(() => reassignedProofReachedHook, "proof event pre-lock barrier");
    await db.update(routesTable).set({
      handoffDriverId: null,
    }).where(and(
      eq(routesTable.id, routeId),
      eq(routesTable.organizationId, organizationId),
    ));
    releaseReassignedProof();
    const reassignedProofResponse = await reassignedProofResponsePromise;
    assert.equal(
      reassignedProofResponse.status,
      403,
      await reassignedProofResponse.clone().text(),
    );
  } finally {
    releaseReassignedProof();
    setBeforeLockedExecutionValidationHookForTests(null);
    await db.update(routesTable).set({
      handoffDriverId: driverProfileId,
    }).where(and(
      eq(routesTable.id, routeId),
      eq(routesTable.organizationId, organizationId),
    ));
  }
  const reassignedProofRows = await db.select().from(deliveryProofsTable).where(and(
    eq(deliveryProofsTable.stopId, stopIds[2]),
    eq(deliveryProofsTable.clientEventId, reassignedProofId),
  ));
  const reassignedProofEvents = await db.select().from(executionEventsTable).where(and(
    eq(executionEventsTable.organizationId, organizationId),
    eq(executionEventsTable.clientEventId, reassignedProofId),
  ));
  assert.equal(reassignedProofRows.length, 0);
  assert.equal(reassignedProofEvents.length, 0);
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(executionMessages(dispatcherOne).length, messagesBeforeReassignedProof);

  const geofenceRaceId = `geofence-race-${randomUUID()}`;
  const messagesBeforeGeofenceRace = executionMessages(dispatcherOne).length;
  let geofenceRaceReachedHook = false;
  let releaseGeofenceRace!: () => void;
  const geofenceRaceRelease = new Promise<void>((resolve) => {
    releaseGeofenceRace = resolve;
  });
  setAfterLockedExecutionValidationHookForTests(async (event) => {
    if (event.clientEventId !== geofenceRaceId) return;
    geofenceRaceReachedHook = true;
    await geofenceRaceRelease;
  });
  try {
    const executionPromise = apiRequest(
      "driver",
      `/api/stops/${stopIds[2]}/execution-events`,
      {
        method: "POST",
        body: JSON.stringify({
          clientEventId: geofenceRaceId,
          type: "failed",
          planVersion: 4,
          occurredAt: new Date(Date.now() + 7_000).toISOString(),
          comment: "Utförandet ska vinna över en gammal geofence-snapshot",
        }),
      },
    );
    await waitFor(() => geofenceRaceReachedHook, "execution event locked geofence barrier");
    const geofencePromise = transitionGeofenceStopStatus({
      organizationId,
      routeId,
      planVersion: 4,
      stopId: stopIds[2],
      expectedStatus: "in_progress",
      nextStatus: "completed",
    });
    releaseGeofenceRace();
    const [executionResponse, geofenceTransition] = await Promise.all([
      executionPromise,
      geofencePromise,
    ]);
    assert.equal(executionResponse.status, 201, await executionResponse.clone().text());
    assert.equal(geofenceTransition, null);
  } finally {
    releaseGeofenceRace();
    setAfterLockedExecutionValidationHookForTests(null);
  }
  const [stopAfterGeofenceRace] = await db
    .select({ status: stopsTable.status })
    .from(stopsTable)
    .where(eq(stopsTable.id, stopIds[2]));
  assert.equal(stopAfterGeofenceRace?.status, "failed");
  await waitFor(
    () => executionMessages(dispatcherOne).length === messagesBeforeGeofenceRace + 1,
    "one failed execution broadcast in geofence race",
  );

  await db.insert(stopsTable).values({
    id: stalePlanGeofenceStopId,
    organizationId,
    routeId,
    address: "Stale plan geofence stop",
    latitude: 59.41,
    longitude: 18.11,
    status: "pending",
    sequenceOrder: 98,
    serviceDurationMin: 10,
  }).onConflictDoNothing();
  const messagesBeforeStalePlanGeofence = dispatcherOne.messages.length;
  await db.update(routesTable).set({
    planRevision: 5,
    handoffStatus: "pending",
    handoffVersion: null,
    handoffDriverId: null,
  }).where(and(
    eq(routesTable.id, routeId),
    eq(routesTable.organizationId, organizationId),
  ));
  try {
    const stalePlanGeofenceTransition = await transitionGeofenceStopStatus({
      organizationId,
      routeId,
      planVersion: 3,
      stopId: stalePlanGeofenceStopId,
      expectedStatus: "pending",
      nextStatus: "in_progress",
    });
    assert.equal(stalePlanGeofenceTransition, null);
  } finally {
    await db.update(routesTable).set({
      planRevision: 4,
      handoffStatus: "accepted",
      handoffVersion: 4,
      handoffDriverId: driverProfileId,
    }).where(and(
      eq(routesTable.id, routeId),
      eq(routesTable.organizationId, organizationId),
    ));
  }
  const [stopAfterStalePlanGeofence] = await db
    .select({ status: stopsTable.status })
    .from(stopsTable)
    .where(eq(stopsTable.id, stalePlanGeofenceStopId));
  assert.equal(stopAfterStalePlanGeofence?.status, "pending");
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(dispatcherOne.messages.length, messagesBeforeStalePlanGeofence);

  await db.insert(stopsTable).values({
    id: reoptimizationRaceStopId,
    organizationId,
    routeId,
    address: "Reoptimization race stop",
    latitude: 59.4,
    longitude: 18.1,
    status: "pending",
    sequenceOrder: 99,
    serviceDurationMin: 10,
  }).onConflictDoNothing();
  const reoptimizationRaceId = `reoptimization-race-${randomUUID()}`;
  let reoptimizationRaceReachedHook = false;
  let releaseReoptimizationRace!: () => void;
  const reoptimizationRaceRelease = new Promise<void>((resolve) => {
    releaseReoptimizationRace = resolve;
  });
  setAfterLockedExecutionValidationHookForTests(async (event) => {
    if (event.clientEventId !== reoptimizationRaceId) return;
    reoptimizationRaceReachedHook = true;
    await reoptimizationRaceRelease;
  });
  try {
    const executionPromise = apiRequest(
      "driver",
      `/api/stops/${reoptimizationRaceStopId}/execution-events`,
      {
        method: "POST",
        body: JSON.stringify({
          clientEventId: reoptimizationRaceId,
          type: "completed",
          planVersion: 4,
          occurredAt: new Date(Date.now() + 8_000).toISOString(),
          actualDurationMin: 12,
        }),
      },
    );
    await waitFor(
      () => reoptimizationRaceReachedHook,
      "execution event locked reoptimization barrier",
    );
    const reoptimizationPromise = db.transaction((tx) =>
      lockAndValidateReoptimizationSnapshot(
        tx,
        organizationId,
        [{ id: routeId, planRevision: 4 }],
        [{
          id: reoptimizationRaceStopId,
          status: "pending",
          routeId,
          sequenceOrder: 99,
        }],
      ),
    );
    const reoptimizationRejected = assert.rejects(
      reoptimizationPromise,
      (error: unknown) => error instanceof ReoptimizationSnapshotConflictError,
    );
    releaseReoptimizationRace();
    const executionResponse = await executionPromise;
    assert.equal(executionResponse.status, 201, await executionResponse.clone().text());
    await reoptimizationRejected;
  } finally {
    releaseReoptimizationRace();
    setAfterLockedExecutionValidationHookForTests(null);
  }
  const [[stopAfterReoptimizationRace], [routeAfterReoptimizationRace]] = await Promise.all([
    db.select({ status: stopsTable.status }).from(stopsTable).where(
      eq(stopsTable.id, reoptimizationRaceStopId),
    ),
    db.select({
      planRevision: routesTable.planRevision,
      executionProjection: routesTable.executionProjection,
    }).from(routesTable).where(eq(routesTable.id, routeId)),
  ]);
  assert.equal(stopAfterReoptimizationRace?.status, "completed");
  assert.equal(routeAfterReoptimizationRace?.planRevision, 4);
  assert.ok(routeAfterReoptimizationRace?.executionProjection);

  await Promise.all([
    closeSocket(dispatcherOne.socket),
    closeSocket(dispatcherTwo.socket),
  ]);

  const assistanceHeaders = {
    "X-Traivo-Assist-Driver-Id": driverProfileId,
    "X-Traivo-Assist-Route-Id": routeId,
  };
  const selected = await apiRequest("admin", "/api/driver-assistance");
  assert.equal(selected.status, 200, await selected.clone().text());
  assert.equal(
    (await selected.json() as Array<{ driver: { id: string }; route: { id: string } }>).some(
      (assignment) => assignment.driver.id === driverProfileId && assignment.route.id === routeId,
    ),
    true,
  );
  const assistedStats = await apiRequest(
    "admin",
    `/api/drivers/${driverProfileId}/stats`,
    { headers: assistanceHeaders },
  );
  assert.equal(assistedStats.status, 200, await assistedStats.clone().text());
  const assistedPreferences = await apiRequest(
    "admin",
    `/api/drivers/${driverProfileId}/preferences`,
    {
      method: "PUT",
      headers: assistanceHeaders,
      body: JSON.stringify({ avoidNightDriving: true }),
    },
  );
  assert.equal(assistedPreferences.status, 200, await assistedPreferences.clone().text());
  assert.equal(
    (await assistedPreferences.json() as { avoidNightDriving: boolean }).avoidNightDriving,
    true,
  );
  const forgedPreferenceScope = await apiRequest(
    "admin",
    `/api/drivers/${randomUUID()}/preferences`,
    {
      method: "PUT",
      headers: assistanceHeaders,
      body: JSON.stringify({ avoidNightDriving: false }),
    },
  );
  assert.equal(forgedPreferenceScope.status, 409, await forgedPreferenceScope.clone().text());
  const forgedRouteRead = await apiRequest(
    "admin",
    `/api/routes/${randomUUID()}/execution`,
    { headers: assistanceHeaders },
  );
  assert.equal(forgedRouteRead.status, 409, await forgedRouteRead.clone().text());
  const assistanceStart = await apiRequest("admin", `/api/routes/${routeId}/execution/start`, {
    method: "POST",
    headers: assistanceHeaders,
    body: JSON.stringify({ clientEventId: `assist-start-${randomUUID()}`, occurredAt: new Date().toISOString() }),
  });
  assert.equal(assistanceStart.status, 201, await assistanceStart.clone().text());
  // This fixture intentionally adds race-test stops that remain pending. Mark
  // only its disposable fixture route terminal before exercising the real end
  // lifecycle guard.
  await db.update(stopsTable).set({ status: "completed" }).where(and(
    eq(stopsTable.organizationId, organizationId),
    eq(stopsTable.routeId, routeId),
  ));
  const assistanceEnd = await apiRequest("admin", `/api/routes/${routeId}/execution/end`, {
    method: "POST",
    headers: assistanceHeaders,
    body: JSON.stringify({ clientEventId: `assist-end-${randomUUID()}`, occurredAt: new Date().toISOString() }),
  });
  assert.equal(assistanceEnd.status, 201, await assistanceEnd.clone().text());

  const assistedId = `admin-assisted-${randomUUID()}`;
  const assisted = await apiRequest("admin", `/api/stops/${stopIds[2]}/execution-events`, {
    method: "POST",
    headers: assistanceHeaders,
    body: JSON.stringify({
      clientEventId: assistedId,
      type: "comment",
      planVersion: 4,
      occurredAt: new Date().toISOString(),
      comment: "Assisted by admin",
    }),
  });
  assert.equal(assisted.status, 201, await assisted.clone().text());
  const [assistedEvent] = await db.select({
    actorUserId: executionEventsTable.actorUserId,
  }).from(executionEventsTable).where(eq(executionEventsTable.clientEventId, assistedId));
  assert.equal(assistedEvent?.actorUserId, userIds.admin);
  await new Promise((resolve) => setTimeout(resolve, 30));
  const audits = await db.select({
    userId: auditLogTable.userId,
    metadata: auditLogTable.metadata,
  }).from(auditLogTable).where(and(
    eq(auditLogTable.organizationId, organizationId),
    eq(auditLogTable.userId, userIds.admin),
  ));
  assert.equal(audits.some((audit) => {
    const metadata = audit.metadata as Record<string, unknown> | null;
    return metadata?.assistedDriverId === driverProfileId && metadata.assistedRouteId === routeId;
  }), true);

  const invalidHeaders = {
    "X-Traivo-Assist-Driver-Id": randomUUID(),
    "X-Traivo-Assist-Route-Id": routeId,
  };
  const deniedId = `forged-assisted-${randomUUID()}`;
  const forgedAdmin = await apiRequest("admin", `/api/stops/${stopIds[2]}/execution-events`, {
    method: "POST", headers: invalidHeaders,
    body: JSON.stringify({ clientEventId: deniedId, type: "comment", planVersion: 4, occurredAt: new Date().toISOString(), comment: "must fail" }),
  });
  assert.ok([403, 409].includes(forgedAdmin.status), await forgedAdmin.clone().text());
  const forgedDriver = await apiRequest("driver", `/api/stops/${stopIds[2]}/execution-events`, {
    method: "POST", headers: assistanceHeaders,
    body: JSON.stringify({ clientEventId: `driver-forged-${randomUUID()}`, type: "comment", planVersion: 4, occurredAt: new Date().toISOString(), comment: "must fail" }),
  });
  assert.equal(forgedDriver.status, 403, await forgedDriver.clone().text());
  const forgedViewer = await apiRequest("viewer", `/api/stops/${stopIds[2]}/execution-events`, {
    method: "POST", headers: assistanceHeaders,
    body: JSON.stringify({ clientEventId: `viewer-forged-${randomUUID()}`, type: "comment", planVersion: 4, occurredAt: new Date().toISOString(), comment: "must fail" }),
  });
  assert.equal(forgedViewer.status, 403, await forgedViewer.clone().text());
  assert.equal((await db.select().from(executionEventsTable).where(eq(executionEventsTable.clientEventId, deniedId))).length, 0);

  const gps = await apiRequest("admin", "/api/tracking/location", {
    method: "POST", headers: assistanceHeaders,
    body: JSON.stringify({ vehicleId, routeId, clientSessionId: randomUUID(), latitude: 59.3, longitude: 18.0 }),
  });
  assert.equal(gps.status, 403, await gps.clone().text());
});