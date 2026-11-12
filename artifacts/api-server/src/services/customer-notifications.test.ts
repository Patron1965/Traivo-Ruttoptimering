import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import { and, eq, inArray } from "drizzle-orm";
import {
  db,
  customerNotificationAttemptsTable,
  deliveryNotificationsTable,
  driversTable,
  executionEventsTable,
  organizationServicePoliciesTable,
  organizationsTable,
  routeDispatchSnapshotsTable,
  routeExecutionsTable,
  routesTable,
  stopsTable,
  usersTable,
  vehiclesTable,
  auditLogTable,
} from "@workspace/db";
import { manageCustomerLink } from "./customer-links";
import { customerSmsPreview, sendCustomerLinkSms } from "./customer-link-sms";
import { customerTransport } from "./customer-notification-transport";
import type { EmailPayload } from "./resend-email";
import type { CustomerNotificationConfig } from "./customer-notification-config";
import { notifyRouteCustomers, recoverCustomerNotification } from "./customer-notifications";
import { captureRouteDispatchSnapshot, getRouteDispatchSnapshot } from "./route-dispatch-snapshot-service";

const organizationId = randomUUID();
const foreignOrganizationId = randomUUID();
const userId = randomUUID();
const vehicleId = randomUUID();
const driverId = randomUUID();
const routeId = randomUUID();
const stopIds = {
  firstPending: randomUUID(),
  secondPending: randomUUID(),
  completed: randomUUID(),
  failed: randomUUID(),
  skipped: randomUUID(),
};
const capturedAt = new Date();
const oldTrackingBase = process.env.PUBLIC_TRACKING_BASE_URL;
const oldSecret = process.env.SESSION_SECRET;

const template = (event: string) => ({
  sms: `${event}: {{customer_name}} at {{address}}`,
  subject: `${event} {{date}}`,
  email: `${event}: {{customer_name}} at {{address}} on {{date}}`,
});

async function verifySharedSmsClaim() {
  const stopId = stopIds.firstPending;
  await db.delete(customerNotificationAttemptsTable).where(and(
    eq(customerNotificationAttemptsTable.stopId, stopId), eq(customerNotificationAttemptsTable.event, "approaching"),
  ));
  let calls = 0;
  const transport = { ...customerTransport, configuredProvider: () => "linkmobility" as const,
    sendSms: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 20)); return "sent" as const; },
    sendEmail: async () => { throw new Error("Email must remain independent"); } };
  const smsConfig = { ...config(false, false, false), channel: "sms" as const };
  await db.update(organizationsTable).set({ customerNotifications: smsConfig }).where(eq(organizationsTable.id, organizationId));
  await notifyRouteCustomers(routeId, organizationId, "approaching", undefined, transport);
  assert.equal(calls, 0);
  smsConfig.events.approaching.enabled = true;
  await db.update(organizationsTable).set({ customerNotifications: smsConfig }).where(eq(organizationsTable.id, organizationId));
  await manageCustomerLink(stopId, organizationId, "revoke");
  await notifyRouteCustomers(routeId, organizationId, "approaching", undefined, transport);
  assert.equal(calls, 0);
  assert.equal((await manageCustomerLink(stopId, organizationId)).status, "revoked");
  await manageCustomerLink(stopId, organizationId, "replace");
  await db.update(stopsTable).set({ contactPhone: "+46700000000" }).where(eq(stopsTable.id, stopId));
  const preview = await customerSmsPreview(stopId, organizationId, transport);
  const input = { revision: preview.revision, confirmation: preview.confirmation, resend: false };
  await Promise.all([
    sendCustomerLinkSms(stopId, organizationId, userId, input, transport),
    notifyRouteCustomers(routeId, organizationId, "approaching", undefined, transport),
  ]);
  assert.equal(calls, 1);
  await notifyRouteCustomers(routeId, organizationId, "approaching", undefined, transport);
  await sendCustomerLinkSms(stopId, organizationId, userId, input, transport);
  assert.equal(calls, 1, "repeated triggers and lost client responses cannot resend");
}

function config(planned: boolean, approaching: boolean, completed: boolean): CustomerNotificationConfig {
  return {
    channel: "both",
    events: {
      planned: { enabled: planned, ...template("Planned") },
      approaching: { enabled: approaching, ...template("Approaching") },
      completed: { enabled: completed, ...template("Completed") },
    },
  };
}

const initialConfig = config(true, true, false);

async function eventAttempts(event: string, orgId = organizationId) {
  return db.select().from(customerNotificationAttemptsTable).where(and(
    eq(customerNotificationAttemptsTable.organizationId, orgId),
    eq(customerNotificationAttemptsTable.event, event),
  ));
}

before(async () => {
  process.env.PUBLIC_TRACKING_BASE_URL = "https://tracking.example.test";
  process.env.SESSION_SECRET = "synthetic-notification-secret-at-least-32-characters";
  await db.insert(organizationsTable).values([
    {
      id: organizationId,
      name: "Synthetic customer-notification fixture",
      email: `${organizationId}@fixture.invalid`,
      customerNotifications: initialConfig,
    },
    {
      id: foreignOrganizationId,
      name: "Synthetic foreign notification fixture",
      email: `${foreignOrganizationId}@fixture.invalid`,
      customerNotifications: initialConfig,
    },
  ]);
  await db.insert(usersTable).values({
    id: userId,
    organizationId,
    name: "Synthetic notification execution user",
    email: `${userId}@fixture.invalid`,
    role: "dispatcher",
  });
  await db.insert(vehiclesTable).values({
    id: vehicleId,
    organizationId,
    name: "Synthetic notification vehicle",
    licensePlate: "MOCK-NO-SEND-VEHICLE",
  });
  await db.insert(driversTable).values({
    id: driverId,
    organizationId,
    name: "Synthetic notification driver",
    vehicleId,
  });
  await db.insert(organizationServicePoliciesTable).values([
    {
      organizationId,
      policy: {
        roadProvider: "disabled",
        geocodingProvider: "disabled",
        smsProvider: "linkmobility",
        emailEnabled: true,
        aiEnabled: false,
        cuoptEnabled: false,
        districtEnabled: false,
      },
    },
    {
      organizationId: foreignOrganizationId,
      policy: {
        roadProvider: "disabled",
        geocodingProvider: "disabled",
        smsProvider: "linkmobility",
        emailEnabled: true,
        aiEnabled: false,
        cuoptEnabled: false,
        districtEnabled: false,
      },
    },
  ]);
  await db.insert(routesTable).values({
    id: routeId,
    organizationId,
    vehicleId,
    name: "Synthetic notification route",
    status: "in_progress",
    planRevision: 1,
    handoffStatus: "accepted",
    handoffVersion: 1,
    handoffDriverId: driverId,
    date: capturedAt,
    totalStops: 5,
  });
  await db.insert(stopsTable).values([
    {
      id: stopIds.firstPending,
      organizationId,
      routeId,
      address: "Snapshot pending stop A",
      latitude: 59.31,
      longitude: 18.06,
      sequenceOrder: 1,
      planningDate: capturedAt,
      status: "pending",
      contactName: "Mock-only customer A",
      contactPhone: "MOCK-NO-SEND-PHONE-A",
      contactEmail: null,
    },
    {
      id: stopIds.secondPending,
      organizationId,
      routeId,
      address: "Snapshot pending stop B",
      latitude: 59.32,
      longitude: 18.07,
      sequenceOrder: 2,
      planningDate: capturedAt,
      status: "pending",
      contactName: "Mock-only customer B",
      contactPhone: "MOCK-NO-SEND-PHONE-B",
      contactEmail: "mock-only-b@fixture.invalid",
    },
    {
      id: stopIds.completed,
      organizationId,
      routeId,
      address: "Snapshot completed stop",
      latitude: 59.33,
      longitude: 18.08,
      sequenceOrder: 3,
      planningDate: capturedAt,
      status: "completed",
      terminalAt: capturedAt,
      contactName: "Mock-only completed customer",
      contactPhone: "MOCK-NO-SEND-PHONE-C",
      contactEmail: "mock-only-c@fixture.invalid",
    },
    {
      id: stopIds.failed,
      organizationId,
      routeId,
      address: "Snapshot failed stop",
      latitude: 59.34,
      longitude: 18.09,
      sequenceOrder: 4,
      planningDate: capturedAt,
      status: "failed",
      terminalAt: capturedAt,
      contactName: "Mock-only failed customer",
      contactPhone: "MOCK-NO-SEND-PHONE-D",
      contactEmail: "mock-only-d@fixture.invalid",
    },
    {
      id: stopIds.skipped,
      organizationId,
      routeId,
      address: "Snapshot skipped stop",
      latitude: 59.35,
      longitude: 18.1,
      sequenceOrder: 5,
      planningDate: capturedAt,
      status: "skipped",
      terminalAt: capturedAt,
      skipReason: "OTHER",
      contactName: "Mock-only skipped customer",
      contactPhone: "MOCK-NO-SEND-PHONE-E",
      contactEmail: "mock-only-e@fixture.invalid",
    },
  ]);
  for (const stopId of Object.values(stopIds)) await manageCustomerLink(stopId, organizationId, "create");
});

after(async () => {
  if (oldTrackingBase === undefined) delete process.env.PUBLIC_TRACKING_BASE_URL; else process.env.PUBLIC_TRACKING_BASE_URL = oldTrackingBase;
  if (oldSecret === undefined) delete process.env.SESSION_SECRET; else process.env.SESSION_SECRET = oldSecret;
  await db.delete(auditLogTable).where(inArray(auditLogTable.organizationId, [organizationId, foreignOrganizationId]));
  // Attempts have no stop foreign key and must be removed before the fixture org.
  await db.delete(customerNotificationAttemptsTable).where(inArray(
    customerNotificationAttemptsTable.organizationId,
    [organizationId, foreignOrganizationId],
  ));
  await db.delete(deliveryNotificationsTable).where(eq(deliveryNotificationsTable.routeId, routeId));
  await db.delete(routeExecutionsTable).where(eq(routeExecutionsTable.organizationId, organizationId));
  await db.delete(executionEventsTable).where(eq(executionEventsTable.organizationId, organizationId));
  await db.delete(routeDispatchSnapshotsTable).where(eq(routeDispatchSnapshotsTable.organizationId, organizationId));
  await db.delete(stopsTable).where(inArray(stopsTable.organizationId, [organizationId, foreignOrganizationId]));
  await db.delete(routesTable).where(inArray(routesTable.organizationId, [organizationId, foreignOrganizationId]));
  await db.delete(driversTable).where(inArray(driversTable.organizationId, [organizationId, foreignOrganizationId]));
  await db.delete(vehiclesTable).where(inArray(vehiclesTable.organizationId, [organizationId, foreignOrganizationId]));
  await db.delete(organizationServicePoliciesTable).where(inArray(
    organizationServicePoliciesTable.organizationId,
    [organizationId, foreignOrganizationId],
  ));
  await db.delete(usersTable).where(inArray(usersTable.organizationId, [organizationId, foreignOrganizationId]));
  await db.delete(organizationsTable).where(inArray(organizationsTable.id, [organizationId, foreignOrganizationId]));
});

test("customer notifications require a dispatch snapshot, active execution, valid target status, and unique channel claims", async () => {
  const smsCalls: Array<{ to: string; message: string }> = [];
  const emailCalls: Array<EmailPayload> = [];
  const transport: Parameters<typeof notifyRouteCustomers>[4] = {
    configuredProvider: () => "linkmobility",
    sendSms: async (to, message) => {
      smsCalls.push({ to, message });
      await new Promise((resolve) => setTimeout(resolve, 5));
      return true;
    },
    sendEmail: async (payload) => {
      emailCalls.push(payload);
      await new Promise((resolve) => setTimeout(resolve, 5));
      return false;
    },
  };

  // Enabled configuration alone is insufficient: no immutable dispatch proof exists yet.
  await notifyRouteCustomers(routeId, organizationId, "planned", undefined, transport);
  assert.equal((await eventAttempts("planned")).length, 0);
  assert.equal(smsCalls.length, 0);
  assert.equal(emailCalls.length, 0);

  const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
  const routeStops = await db.select().from(stopsTable).where(eq(stopsTable.routeId, routeId));
  await db.transaction((tx) => captureRouteDispatchSnapshot(tx, route!, routeStops, driverId, capturedAt));
  const snapshot = await getRouteDispatchSnapshot(organizationId, routeId);
  assert.equal(snapshot?.planRevision, 1);
  assert.equal((await db.select().from(routesTable).where(eq(routesTable.id, routeId)))[0]?.dispatchSnapshotVersion, 1);

  // A disabled event creates no attempt even when a valid snapshot exists.
  await db.update(organizationsTable)
    .set({ customerNotifications: config(false, true, false) })
    .where(eq(organizationsTable.id, organizationId));
  await notifyRouteCustomers(routeId, organizationId, "planned", undefined, transport);
  assert.equal((await eventAttempts("planned")).length, 0);
  assert.equal(smsCalls.length, 0);
  assert.equal(emailCalls.length, 0);

  await db.update(organizationsTable)
    .set({ customerNotifications: initialConfig })
    .where(eq(organizationsTable.id, organizationId));

  // Approaching messages require an active execution, not merely a dispatched route.
  await notifyRouteCustomers(routeId, organizationId, "approaching", undefined, transport);
  assert.equal((await eventAttempts("approaching")).length, 0);
  assert.equal(smsCalls.length, 0);
  await db.insert(routeExecutionsTable).values({
    organizationId,
    routeId,
    driverId,
    planVersion: 1,
    status: "active",
    startedAt: capturedAt,
    startClientEventId: randomUUID(),
    startedByUserId: userId,
  });

  // Two concurrent first-dispatch invocations still claim each stop/event/channel once.
  await Promise.all([
    notifyRouteCustomers(routeId, organizationId, "planned", undefined, transport),
    notifyRouteCustomers(routeId, organizationId, "planned", undefined, transport),
  ]);
  const planned = await eventAttempts("planned");
  assert.equal(planned.length, 4);
  assert.equal(new Set(planned.map((attempt) => `${attempt.stopId}:${attempt.event}:${attempt.channel}`)).size, 4);
  assert.equal(smsCalls.length, 2);
  assert.equal(emailCalls.length, 1);
  const plannedStatus = new Map(planned.map((attempt) => [`${attempt.stopId}:${attempt.channel}`, attempt.status]));
  assert.equal(plannedStatus.get(`${stopIds.firstPending}:sms`), "sent");
  assert.equal(plannedStatus.get(`${stopIds.firstPending}:email`), "missing_recipient");
  assert.equal(plannedStatus.get(`${stopIds.secondPending}:sms`), "sent");
  assert.equal(plannedStatus.get(`${stopIds.secondPending}:email`), "unknown");
  assert(smsCalls.some((call) => call.to === "MOCK-NO-SEND-PHONE-A"));
  assert(smsCalls.some((call) => call.message.includes("Snapshot pending stop A")));
  assert(emailCalls.some((call) => call.to === "mock-only-b@fixture.invalid"));

  await notifyRouteCustomers(routeId, organizationId, "approaching", undefined, transport);
  const approaching = await eventAttempts("approaching");
  assert.equal(approaching.length, 2);
  assert(approaching.every((attempt) => attempt.stopId === stopIds.firstPending));
  assert.equal(smsCalls.length, 3);
  assert.equal(emailCalls.length, 1, "missing email must not block SMS for the first pending stop");

  // The completed event is independently disabled until enabled below.
  await notifyRouteCustomers(routeId, organizationId, "completed", stopIds.completed, transport);
  assert.equal((await eventAttempts("completed")).length, 0);
  await db.update(organizationsTable)
    .set({ customerNotifications: config(true, true, true) })
    .where(eq(organizationsTable.id, organizationId));

  await notifyRouteCustomers(routeId, organizationId, "completed", stopIds.completed, transport);
  const completed = await eventAttempts("completed");
  assert.equal(completed.length, 2);
  assert(completed.every((attempt) => attempt.stopId === stopIds.completed));
  assert.equal(completed.find((attempt) => attempt.channel === "sms")?.status, "sent");
  assert.equal(completed.find((attempt) => attempt.channel === "email")?.status, "unknown");
  const callsBeforeInvalidTerminalTargets = { sms: smsCalls.length, email: emailCalls.length };
  await notifyRouteCustomers(routeId, organizationId, "completed", stopIds.failed, transport);
  await notifyRouteCustomers(routeId, organizationId, "completed", stopIds.skipped, transport);
  assert.equal((await eventAttempts("completed")).length, 2);
  assert.deepEqual(
    { sms: smsCalls.length, email: emailCalls.length },
    callsBeforeInvalidTerminalTargets,
    "failed and skipped stops must not produce completion messages",
  );

  const callsBeforeForeign = { sms: smsCalls.length, email: emailCalls.length };
  await notifyRouteCustomers(routeId, foreignOrganizationId, "planned", undefined, transport);
  assert.equal((await eventAttempts("planned", foreignOrganizationId)).length, 0);
  assert.deepEqual(
    { sms: smsCalls.length, email: emailCalls.length },
    callsBeforeForeign,
    "a route from another organization must not produce provider calls",
  );

  await verifySharedSmsClaim();
  const missing = planned.find(a => a.status === "missing_recipient")!;
  const recovery = { id: missing.id, revision: missing.revision, recipient: "corrected@fixture.invalid", actorId: userId };
  assert.equal(await recoverCustomerNotification(foreignOrganizationId, recovery, transport), false);
  // Opt-out is checked again, not inherited from the original claim.
  await db.update(organizationsTable).set({ customerNotifications: config(false, true, true) }).where(eq(organizationsTable.id, organizationId));
  assert.equal(await recoverCustomerNotification(organizationId, recovery, transport), false);
  await db.update(organizationsTable).set({ customerNotifications: config(true, true, true) }).where(eq(organizationsTable.id, organizationId));
  const emailBeforeRecovery = emailCalls.length;
  const outcomes = await Promise.all([
    recoverCustomerNotification(organizationId, recovery, transport),
    recoverCustomerNotification(organizationId, recovery, transport),
  ]);
  assert.equal(outcomes.filter(Boolean).length, 1);
  assert.equal(emailCalls.length, emailBeforeRecovery + 1);
  assert.equal(emailCalls.at(-1)?.to, recovery.recipient);
  const [recovered] = await db.select().from(customerNotificationAttemptsTable).where(eq(customerNotificationAttemptsTable.id, missing.id));
  assert.equal(recovered.status, "unknown");
  assert.equal(recovered.revision, 1);
  assert.equal(recovered.history[0].status, "missing_recipient");
  assert.equal(recovered.history[0].actorId, userId);
  assert.equal(await recoverCustomerNotification(organizationId, { ...recovery, revision: 1 }, transport), false);
  // A durable "sending" intent after process death is never reclaimed.
  for (const status of ["sending", "sent", "failed", "unknown", "channel_unavailable"]) {
    await db.update(customerNotificationAttemptsTable).set({ status }).where(eq(customerNotificationAttemptsTable.id, missing.id));
    assert.equal(await recoverCustomerNotification(organizationId, { ...recovery, revision: 1 }, transport), false, status);
  }
  await db.update(customerNotificationAttemptsTable).set({ status: "rejected" }).where(eq(customerNotificationAttemptsTable.id, missing.id));
  const successful = { ...transport, sendEmail: async () => "sent" as const };
  await db.update(stopsTable).set({ status: "completed" }).where(eq(stopsTable.id, missing.stopId));
  assert.equal(await recoverCustomerNotification(organizationId, { ...recovery, revision: 1 }, successful), false, "a planned message cannot be recovered after completion");
  await db.update(stopsTable).set({ status: "pending" }).where(eq(stopsTable.id, missing.stopId));
  assert.equal(await recoverCustomerNotification(organizationId, { ...recovery, revision: 1 }, successful), true);
  assert.equal(await recoverCustomerNotification(organizationId, { ...recovery, revision: 1 }, successful), false);
});
