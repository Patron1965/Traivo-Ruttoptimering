import { outgoingRoute, outgoingStopContext, outgoingStops } from "./outgoing-route-service";
import { and, asc, eq, inArray } from "drizzle-orm";
import {
  db,
  deliveryProofsTable,
  executionEventsTable,
  routesTable,
  stopsTable,
} from "@workspace/db";
import { broadcastTenantEvent } from "../ws";
import { getTerminalTimestampForStopStatus } from "./stop-service";
import { assertCurrentDriverAssistance } from "../lib/driver-assistance";
import { hasPickupLeg, readStopSelection, stopSelectionBlocker } from "./execution-stop-selection";

export const STANDARD_SKIP_REASONS = [
  "CUSTOMER_UNAVAILABLE",
  "ACCESS_BLOCKED",
  "ADDRESS_NOT_FOUND",
  "VEHICLE_OR_SAFETY",
  "OTHER",
] as const;

export type ExecutionEventInput = {
  clientEventId: string;
  type: "completed" | "failed" | "skipped" | "proof" | "comment" | "actual_time" | "select_next";
  expectedSelectionRevision?: string;
  planVersion: number;
  occurredAt: string;
  skipReason?: typeof STANDARD_SKIP_REASONS[number];
  comment?: string;
  actualDurationMin?: number;
  proofId?: string;
  proofType?: string;
  proofStage?: string;
  proofContentHash?: string;
};

export type ProofExecutionInput = {
  proofType: string;
  proofStage: "pickup" | "delivery";
  fileUrl: string | null;
  data: string | null;
  notes: string | null;
  contentHash: string;
};

export class ExecutionEventError extends Error {
  constructor(message: string, readonly statusCode: number) {
    super(message);
  }
}

type DbTransaction = Parameters<Parameters<typeof db.transaction>[0]>[0];
type BeforeLockedValidationHook = (event: {
  clientEventId: string;
  stopId: string;
  type: ExecutionEventInput["type"];
}) => Promise<void>;
let beforeLockedValidationHook: BeforeLockedValidationHook | null = null;
let afterLockedValidationHook: BeforeLockedValidationHook | null = null;

export function setBeforeLockedExecutionValidationHookForTests(
  hook: BeforeLockedValidationHook | null,
): void {
  beforeLockedValidationHook = hook;
}

export function setAfterLockedExecutionValidationHookForTests(
  hook: BeforeLockedValidationHook | null,
): void {
  afterLockedValidationHook = hook;
}

export function assertCurrentExecutionPlanVersion(received: number, current: number): void {
  if (received !== current) {
    throw new ExecutionEventError(
      `Stale plan version ${received}; current version is ${current}`,
      409,
    );
  }
}

export function assertDuplicateExecutionEventCompatible(
  existing: {
    stopId: string;
    eventType: string;
    planVersion?: number;
    occurredAt?: Date;
    payload?: Record<string, unknown>;
  },
  stopId: string,
  input: Pick<
    ExecutionEventInput,
    | "type"
    | "planVersion"
    | "occurredAt"
    | "skipReason"
    | "comment"
    | "actualDurationMin"
    | "proofType"
    | "proofStage"
    | "proofContentHash"
    | "expectedSelectionRevision"
  >,
): void {
  const normalizedPayload = {
    expectedSelectionRevision: input.expectedSelectionRevision,
    skipReason: input.skipReason,
    comment: input.comment?.trim() || undefined,
    actualDurationMin: input.actualDurationMin,
    proofType: input.proofType,
    proofStage: input.proofStage,
    proofContentHash: input.proofContentHash,
  };
  const payloadKeys = [
    "expectedSelectionRevision",
    "skipReason",
    "comment",
    "actualDurationMin",
    "proofType",
    "proofStage",
    "proofContentHash",
  ] as const;
  const payloadMismatch = existing.payload != null && payloadKeys.some((key) =>
    Object.prototype.hasOwnProperty.call(existing.payload, key)
    && existing.payload?.[key] !== normalizedPayload[key]
  );
  if (
    existing.stopId !== stopId
    || existing.eventType !== input.type
    || (existing.planVersion != null && existing.planVersion !== input.planVersion)
    || (
      input.type !== "select_next" && existing.occurredAt != null
      && existing.occurredAt.toISOString() !== new Date(input.occurredAt).toISOString()
    )
    || payloadMismatch
  ) {
    throw new ExecutionEventError("clientEventId was already used for a different execution event", 409);
  }
}

function assertDuplicateProofCompatible(
  existing: typeof deliveryProofsTable.$inferSelect,
  stopId: string,
  input: ProofExecutionInput,
): void {
  if (
    existing.stopId !== stopId
    || existing.proofType !== input.proofType
    || existing.proofStage !== input.proofStage
    || existing.notes !== input.notes
    || existing.data !== input.data
  ) {
    throw new ExecutionEventError(
      "clientEventId was already used for different proof data",
      409,
    );
  }
}

export function plannedCompletionTimes(timeline: Array<{ type: string; endAt: string }> | null | undefined) {
  const depotEnd = timeline?.find((item) => item.type === "depot_end")?.endAt ?? null;
  const returnEnd = timeline?.find((item) => item.type === "return")?.endAt ?? null;
  return { expectedFinishAt: depotEnd ?? returnEnd, depotReturnAt: returnEnd ?? depotEnd };
}

export async function findExecutionEvent(organizationId: string, clientEventId: string) {
  const [event] = await db.select().from(executionEventsTable).where(and(
    eq(executionEventsTable.organizationId, organizationId),
    eq(executionEventsTable.clientEventId, clientEventId),
  )).limit(1);
  return event ?? null;
}

export async function validateExecutionEventContext(args: {
  organizationId: string;
  driverProfileId: string | null;
  role: string;
  stopId: string;
  planVersion: number;
  assistedRouteId?: string | null;
  assistedDriverId?: string | null;
}) {
  if (args.role === "driver") {
    if (!args.driverProfileId) throw new ExecutionEventError("Driver profile required", 403);
    const context = await outgoingStopContext(args.organizationId, args.stopId, args.driverProfileId);
    if (context.route.handoffStatus !== "accepted") throw new ExecutionEventError("Den utskickade versionen är inte kvitterad.", 409);
    assertCurrentExecutionPlanVersion(args.planVersion, context.route.planRevision);
    assertCurrentDriverAssistance(context.route, args.assistedRouteId && args.assistedDriverId
      ? { routeId: args.assistedRouteId, driverId: args.assistedDriverId } : null);
    return context;
  }
  const [stop] = await db.select().from(stopsTable).where(and(
    eq(stopsTable.id, args.stopId),
    eq(stopsTable.organizationId, args.organizationId),
  )).limit(1);
  if (!stop?.routeId) throw new ExecutionEventError("Stop not found", 404);
  if (stop.archivedAt) {
    throw new ExecutionEventError("Archived stops are historical records and cannot receive execution events", 409);
  }
  const [route] = await db.select().from(routesTable).where(and(
    eq(routesTable.id, stop.routeId),
    eq(routesTable.organizationId, args.organizationId),
  )).limit(1);
  if (!route) throw new ExecutionEventError("Route not found", 404);
  assertCurrentDriverAssistance(route, args.assistedRouteId && args.assistedDriverId
    ? { routeId: args.assistedRouteId, driverId: args.assistedDriverId }
    : null);
  if (args.role === "driver" && (!args.driverProfileId || route.handoffDriverId !== args.driverProfileId)) {
    throw new ExecutionEventError("Stop is not assigned to this driver", 403);
  }
  if (
    args.role === "driver"
    && (route.handoffStatus !== "accepted" || route.handoffVersion !== route.planRevision)
  ) {
    throw new ExecutionEventError("The current route plan has not been accepted", 409);
  }
  assertCurrentExecutionPlanVersion(args.planVersion, route.planRevision);
  return { stop, route };
}

async function projectionForRoute(
  tx: DbTransaction,
  route: typeof routesTable.$inferSelect,
  organizationId: string,
) {
  const [events, workingStops] = await Promise.all([
    tx.select().from(executionEventsTable).where(and(
      eq(executionEventsTable.organizationId, organizationId),
      eq(executionEventsTable.routeId, route.id),
    )).orderBy(asc(executionEventsTable.occurredAt), asc(executionEventsTable.createdAt)),
    tx.select().from(stopsTable).where(and(
      eq(stopsTable.organizationId, organizationId),
      eq(stopsTable.routeId, route.id),
    )).orderBy(asc(stopsTable.sequenceOrder)),
  ]);
  const stops = route.dispatchSnapshotVersion != null ? await outgoingStops(route, tx) : workingStops;
  const actualByStop = new Map<string, number>();
  for (const event of events) {
    const actual = event.payload.actualDurationMin;
    if (typeof actual === "number") actualByStop.set(event.stopId, actual);
  }
  const deviationMin = stops.reduce(
    (total, stop) => total + (actualByStop.get(stop.id) == null
      ? 0
      : actualByStop.get(stop.id)! - stop.serviceDurationMin),
    0,
  );
  const shift = (value?: string | null) => value
    ? new Date(new Date(value).getTime() + deviationMin * 60_000).toISOString()
    : null;
  const plannedTimes = plannedCompletionTimes(route.workdayTimeline);
  const expectedFinishAt = shift(plannedTimes.expectedFinishAt);
  const remainingEtas = (route.plannerItinerary ?? [])
    .filter((item) => {
      const stop = stops.find((candidate) => candidate.id === item.stopId);
      return stop?.status === "pending";
    })
    .map((item) => ({ stopId: item.stopId, eta: shift(item.estimatedArrival)! }));
  const overtimeMin = Math.max(0, deviationMin - (route.workdaySummary?.marginMin ?? 0));
  return {
    generatedAt: new Date().toISOString(),
    deviationMin,
    expectedFinishAt,
    depotReturnAt: shift(plannedTimes.depotReturnAt),
    overtimeRisk: overtimeMin > 0,
    overtimeMin,
    remainingEtas,
  };
}

async function lockExecutionContext(
  tx: DbTransaction,
  args: {
    organizationId: string;
    driverProfileId: string | null;
    role: string;
    stopId: string;
    planVersion: number;
    expectedRouteId: string;
    assistedRouteId?: string | null;
    assistedDriverId?: string | null;
  },
) {
  let [route] = await tx
    .select()
    .from(routesTable)
    .where(and(
      eq(routesTable.id, args.expectedRouteId),
      eq(routesTable.organizationId, args.organizationId),
    ))
    .limit(1)
    .for("update");
  if (!route) throw new ExecutionEventError("Route not found", 404);
  if (args.role === "driver" && route.handoffDriverId !== args.driverProfileId) {
    throw new ExecutionEventError("Forbidden: route is assigned to another driver", 403);
  }
  if (args.role === "driver") route = await outgoingRoute(route, tx);
  assertCurrentDriverAssistance(route, args.assistedRouteId && args.assistedDriverId
    ? { routeId: args.assistedRouteId, driverId: args.assistedDriverId }
    : null);

  let [stop] = await tx
    .select()
    .from(stopsTable)
    .where(and(
      eq(stopsTable.id, args.stopId),
      eq(stopsTable.organizationId, args.organizationId),
    ))
    .limit(1)
    .for("update");
  if (args.role === "driver") {
    const outgoing = (await outgoingStops(route, tx)).find((candidate) => candidate.id === args.stopId);
    if (!outgoing) throw new ExecutionEventError("Stop not found in outgoing version", 404);
    stop = outgoing;
  }
  if (!stop?.routeId) throw new ExecutionEventError("Stop not found in outgoing version", 404);
  if (stop.archivedAt) {
    throw new ExecutionEventError("Archived stops are historical records and cannot receive execution events", 409);
  }
  if (stop.routeId !== route.id) {
    throw new ExecutionEventError("The stop route changed; reload and retry", 409);
  }
  if (args.role === "driver" && (!args.driverProfileId || route.handoffDriverId !== args.driverProfileId)) {
    throw new ExecutionEventError("Stop is not assigned to this driver", 403);
  }
  if (
    args.role === "driver"
    && (route.handoffStatus !== "accepted" || route.handoffVersion !== route.planRevision)
  ) {
    throw new ExecutionEventError("The current route plan has not been accepted", 409);
  }
  assertCurrentExecutionPlanVersion(args.planVersion, route.planRevision);
  return { stop, route };
}

function eventPayload(input: ExecutionEventInput): Record<string, unknown> {
  return {
    expectedSelectionRevision: input.expectedSelectionRevision,
    skipReason: input.skipReason,
    comment: input.comment?.trim() || undefined,
    actualDurationMin: input.actualDurationMin,
    proofId: input.proofId,
    proofType: input.proofType,
    proofStage: input.proofStage,
    proofContentHash: input.proofContentHash,
  };
}

async function persistProjection(
  tx: DbTransaction,
  route: typeof routesTable.$inferSelect,
  organizationId: string,
) {
  const projection = await projectionForRoute(tx, route, organizationId);
  if (route.dispatchSnapshotVersion != null) {
    const stops = await outgoingStops(route, tx, false);
    const selection = await readStopSelection(route, stops, tx);
    Object.assign(projection, {
      selectionRevision: selection.revision, activeStopId: selection.activeStopId,
      selectionChangedAt: selection.changedAt,
      ...(selection.changedAt ? {
        remainingEtas: [], expectedFinishAt: null, depotReturnAt: null,
        etaUnavailableReason: "Körordningen har ändrats. Planerade tider är inte aktuella ETA-värden.",
      } : {}),
    });
  }
  const suggestion = projection.overtimeRisk ? {
    status: "pending_approval" as const,
    warning: `Actual execution is projected ${projection.overtimeMin} minutes beyond the shift. Remaining stops were not moved.`,
    createdAt: new Date().toISOString(),
  } : null;
  await tx.update(routesTable).set({
    executionProjection: projection,
    redistributionSuggestion: suggestion,
    updatedAt: new Date(),
  }).where(and(eq(routesTable.id, route.id), eq(routesTable.organizationId, organizationId)));
  return { projection, suggestion };
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}

export async function recordExecutionEvent(args: {
  organizationId: string;
  actorUserId: string;
  driverProfileId: string | null;
  role: string;
  stopId: string;
  input: ExecutionEventInput;
  assistedRouteId?: string | null;
  assistedDriverId?: string | null;
}) {
  const { organizationId, actorUserId, driverProfileId, role, stopId, input } = args;
  const existing = await findExecutionEvent(organizationId, input.clientEventId);
  // An assisted retry deliberately enters the route lock below so a driver
  // reassignment between attempts cannot make an old idempotency key an
  // authorization bypass.
  if (existing && !args.assistedRouteId && role !== "driver") {
    assertDuplicateExecutionEventCompatible(existing, stopId, input);
    return { event: existing, duplicate: true };
  }
  const { stop, route } = await validateExecutionEventContext({
    organizationId, driverProfileId, role, stopId, planVersion: input.planVersion,
    assistedRouteId: args.assistedRouteId, assistedDriverId: args.assistedDriverId,
  });
  if (input.type === "skipped" && !STANDARD_SKIP_REASONS.includes(input.skipReason as never)) {
    throw new ExecutionEventError("A standard skip reason is required", 400);
  }
  if (input.actualDurationMin != null && (
    !Number.isInteger(input.actualDurationMin) || input.actualDurationMin < 0
  )) throw new ExecutionEventError("actualDurationMin must be a non-negative integer", 400);

  await beforeLockedValidationHook?.({
    clientEventId: input.clientEventId,
    stopId,
    type: input.type,
  });

  let persisted;
  try {
    persisted = await db.transaction(async (tx) => {
      const locked = await lockExecutionContext(tx, {
        organizationId,
        driverProfileId,
        role,
        stopId,
        planVersion: input.planVersion,
        expectedRouteId: route.id,
        assistedRouteId: args.assistedRouteId,
        assistedDriverId: args.assistedDriverId,
      });
      const [duplicate] = await tx.select().from(executionEventsTable).where(and(
        eq(executionEventsTable.organizationId, organizationId),
        eq(executionEventsTable.clientEventId, input.clientEventId),
      )).limit(1);
      if (duplicate) {
        assertDuplicateExecutionEventCompatible(duplicate, stopId, input);
        return { event: duplicate, duplicate: true as const };
      }
      if (input.type === "select_next") {
        if (role !== "driver") throw new ExecutionEventError("Endast tilldelad chaufför kan välja aktivt stopp.", 403);
        const stops = await outgoingStops(locked.route, tx, false);
        const state = await readStopSelection(locked.route, stops, tx);
        if (!input.expectedSelectionRevision || input.expectedSelectionRevision !== state.revision) {
          throw new ExecutionEventError("Rutten har ändrats. Läs in den igen och välj stopp på nytt.", 409);
        }
        const blocker = stopSelectionBlocker(locked.route, stops, stopId);
        if (blocker) throw new ExecutionEventError(blocker, 409);
        // Pickup proof means the composite pickup/delivery job has begun even
        // if a legacy client has not yet advanced its stop status.
        const proofs = await tx.select({ stopId: deliveryProofsTable.stopId }).from(deliveryProofsTable).where(and(
          inArray(deliveryProofsTable.stopId, stops.map(stop => stop.id)),
          eq(deliveryProofsTable.proofStage, "pickup"),
        ));
        if (proofs.some(proof => proof.stopId !== stopId
          && stops.some(stop => stop.id === proof.stopId && hasPickupLeg(stop)
            && !["completed", "failed", "skipped"].includes(stop.status)))) {
          throw new ExecutionEventError("Slutför leveransen för den påbörjade hämtningen innan du byter stopp.", 409);
        }
      }
      await afterLockedValidationHook?.({
        clientEventId: input.clientEventId,
        stopId,
        type: input.type,
      });
      if (["completed", "failed", "skipped"].includes(locked.stop.status)
        && ["completed", "failed", "skipped"].includes(input.type)) {
        throw new ExecutionEventError("Terminala uppdrag kan inte få en ny livscykelövergång.", 409);
      }
      const [event] = await tx.insert(executionEventsTable).values({
        organizationId,
        routeId: locked.route.id,
        stopId,
        actorUserId,
        clientEventId: input.clientEventId,
        eventType: input.type,
        planVersion: input.planVersion,
        occurredAt: input.type === "select_next" ? new Date() : new Date(input.occurredAt),
        createdAt: new Date(Math.max(Date.now(),
          (Date.parse(locked.route.executionProjection?.selectionChangedAt ?? "") || 0) + 1)),
        payload: eventPayload(input),
      }).returning();
      const terminal = locked.stop.status === "completed"
        || locked.stop.status === "skipped"
        || locked.stop.status === "failed";
      const patch: Record<string, unknown> = {};
      if (!terminal && input.type === "completed") {
        patch.status = "completed";
        patch.terminalAt = getTerminalTimestampForStopStatus("completed");
      } else if (!terminal && input.type === "failed") {
        patch.status = "failed";
        patch.terminalAt = getTerminalTimestampForStopStatus("failed");
      } else if (!terminal && input.type === "skipped") {
        patch.status = "skipped";
        patch.terminalAt = getTerminalTimestampForStopStatus("skipped");
        patch.skipReason = input.skipReason;
        patch.skipComment = input.comment?.trim() || null;
      }
      const terminalEvent = input.type === "completed"
        || input.type === "failed"
        || input.type === "skipped";
      if (input.type === "comment" || (
        (input.type === "completed" || input.type === "failed") && input.comment != null
      )) {
        patch.executionComment = input.comment?.trim() || null;
      }
      if (input.actualDurationMin != null) patch.actualDurationMin = input.actualDurationMin;
      if (Object.keys(patch).length) {
        await tx.update(stopsTable).set(patch).where(and(
          eq(stopsTable.id, stopId),
          eq(stopsTable.organizationId, organizationId),
        ));
      }
      if (terminalEvent && locked.route.lockedFirstStopId === stopId) {
        // Execution-event writes are an independent terminal transition path;
        // clear the route-owned pin without changing plan acceptance state.
        await tx.update(routesTable).set({
          lockedFirstStopId: null,
          updatedAt: new Date(),
        }).where(and(
          eq(routesTable.id, locked.route.id),
          eq(routesTable.organizationId, organizationId),
          eq(routesTable.lockedFirstStopId, stopId),
        ));
      }
      const projectionResult = await persistProjection(
        tx,
        locked.route,
        organizationId,
      );
      return {
        event,
        duplicate: false as const,
        route: locked.route,
        ...projectionResult,
      };
    });
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error;
    const [duplicate] = await db.select().from(executionEventsTable).where(and(
      eq(executionEventsTable.organizationId, organizationId),
      eq(executionEventsTable.clientEventId, input.clientEventId),
    )).limit(1);
    if (!duplicate) throw error;
    assertDuplicateExecutionEventCompatible(duplicate, stopId, input);
    return { event: duplicate, duplicate: true };
  }

  if (persisted.duplicate) return persisted;
  if (["completed", "failed", "skipped"].includes(input.type)) {
    const { notifyRouteCustomers } = await import("./customer-notifications");
    if (input.type === "completed") void notifyRouteCustomers(persisted.route.id, organizationId, "completed", stopId);
    void notifyRouteCustomers(persisted.route.id, organizationId, "approaching");
  }
  const payload = {
    event: persisted.event,
    stopId,
    routeId: persisted.route.id,
    projection: persisted.projection,
    suggestion: persisted.suggestion,
  };
  await broadcastTenantEvent(organizationId, "execution:event", payload);
  return { ...payload, duplicate: false };
}

export async function recordProofExecutionEvent(args: {
  organizationId: string;
  actorUserId: string;
  driverProfileId: string | null;
  role: string;
  stopId: string;
  clientEventId: string;
  planVersion: number;
  occurredAt: string;
  proof: ProofExecutionInput;
  assistedRouteId?: string | null;
  assistedDriverId?: string | null;
}) {
  const {
    organizationId,
    actorUserId,
    driverProfileId,
    role,
    stopId,
    clientEventId,
    planVersion,
    assistedRouteId,
    assistedDriverId,
    occurredAt,
    proof,
  } = args;
  const eventInput: ExecutionEventInput = {
    clientEventId,
    type: "proof",
    planVersion,
    occurredAt,
    comment: proof.notes || undefined,
    proofType: proof.proofType,
    proofStage: proof.proofStage,
    proofContentHash: proof.contentHash,
  };
  const [existingProof, existingEvent] = await Promise.all([
    db.select().from(deliveryProofsTable).where(and(
      eq(deliveryProofsTable.stopId, stopId),
      eq(deliveryProofsTable.clientEventId, clientEventId),
    )).limit(1).then((rows) => rows[0] ?? null),
    findExecutionEvent(organizationId, clientEventId),
  ]);
  if (existingProof && existingEvent && !args.assistedRouteId && role !== "driver") {
    assertDuplicateProofCompatible(existingProof, stopId, proof);
    assertDuplicateExecutionEventCompatible(existingEvent, stopId, eventInput);
    return { proof: existingProof, event: existingEvent, duplicate: true as const };
  }
  if ((existingProof || existingEvent) && !(existingProof && existingEvent && (args.assistedRouteId || role === "driver"))) {
    throw new ExecutionEventError(
      "Proof retry state is incomplete; no duplicate was created",
      409,
    );
  }

  const { route } = await validateExecutionEventContext({
    organizationId,
    driverProfileId,
    role,
    stopId,
    planVersion,
  });
  await beforeLockedValidationHook?.({
    clientEventId,
    stopId,
    type: "proof",
  });

  let persisted;
  try {
    persisted = await db.transaction(async (tx) => {
      const locked = await lockExecutionContext(tx, {
        organizationId,
        driverProfileId,
        role,
        stopId,
        planVersion,
        expectedRouteId: route.id,
        assistedRouteId: args.assistedRouteId,
        assistedDriverId: args.assistedDriverId,
      });
      const [duplicateProof, duplicateEvent] = await Promise.all([
        tx.select().from(deliveryProofsTable).where(and(
          eq(deliveryProofsTable.stopId, stopId),
          eq(deliveryProofsTable.clientEventId, clientEventId),
        )).limit(1).then((rows) => rows[0] ?? null),
        tx.select().from(executionEventsTable).where(and(
          eq(executionEventsTable.organizationId, organizationId),
          eq(executionEventsTable.clientEventId, clientEventId),
        )).limit(1).then((rows) => rows[0] ?? null),
      ]);
      if (duplicateProof && duplicateEvent) {
        assertDuplicateProofCompatible(duplicateProof, stopId, proof);
        assertDuplicateExecutionEventCompatible(duplicateEvent, stopId, eventInput);
        return {
          proof: duplicateProof,
          event: duplicateEvent,
          duplicate: true as const,
        };
      }
      if (duplicateProof || duplicateEvent) {
        throw new ExecutionEventError(
          "Proof retry state is incomplete; no duplicate was created",
          409,
        );
      }
      await afterLockedValidationHook?.({
        clientEventId,
        stopId,
        type: "proof",
      });

      const [insertedProof] = await tx.insert(deliveryProofsTable).values({
        stopId,
        proofType: proof.proofType,
        proofStage: proof.proofStage,
        fileUrl: proof.fileUrl,
        data: proof.data,
        notes: proof.notes,
        clientEventId,
      }).returning();
      const inputWithProof = { ...eventInput, proofId: insertedProof.id };
      const [event] = await tx.insert(executionEventsTable).values({
        organizationId,
        routeId: locked.route.id,
        stopId,
        actorUserId,
        clientEventId,
        eventType: "proof",
        planVersion,
        occurredAt: new Date(occurredAt),
        payload: eventPayload(inputWithProof),
      }).returning();
      const projectionResult = await persistProjection(
        tx,
        locked.route,
        organizationId,
      );
      return {
        proof: insertedProof,
        event,
        duplicate: false as const,
        route: locked.route,
        ...projectionResult,
      };
    });
  } catch (error: unknown) {
    if (!isUniqueViolation(error)) throw error;
    const [duplicateProof, duplicateEvent] = await Promise.all([
      db.select().from(deliveryProofsTable).where(and(
        eq(deliveryProofsTable.stopId, stopId),
        eq(deliveryProofsTable.clientEventId, clientEventId),
      )).limit(1).then((rows) => rows[0] ?? null),
      findExecutionEvent(organizationId, clientEventId),
    ]);
    if (!duplicateProof || !duplicateEvent) throw error;
    assertDuplicateProofCompatible(duplicateProof, stopId, proof);
    assertDuplicateExecutionEventCompatible(duplicateEvent, stopId, eventInput);
    return {
      proof: duplicateProof,
      event: duplicateEvent,
      duplicate: true as const,
    };
  }

  if (persisted.duplicate) return persisted;
  const payload = {
    event: persisted.event,
    stopId,
    routeId: persisted.route.id,
    projection: persisted.projection,
    suggestion: persisted.suggestion,
  };
  await broadcastTenantEvent(organizationId, "execution:event", payload);
  return { ...persisted, duplicate: false as const };
}
