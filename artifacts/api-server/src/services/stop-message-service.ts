import { and, asc, desc, eq, gt, inArray, sql } from "drizzle-orm";
import {
  db,
  routeMessageReadReceiptsTable,
  routeMessagesTable,
  routesTable,
  routeDispatchSnapshotsTable,
  usersTable,
  stopMessageReadReceiptsTable,
  stopMessagesTable,
  stopMessageThreadsTable,
  stopsTable,
} from "@workspace/db";
import { assertCurrentDriverAssistance } from "../lib/driver-assistance";
import { outgoingStopContext } from "./outgoing-route-service";

export type StopMessageActor = {
  organizationId: string;
  userId: string;
  role: string;
  driverProfileId: string | null;
  assistedRouteId?: string | null;
  assistedDriverId?: string | null;
};

export class StopMessageError extends Error {
  constructor(
    message: string,
    readonly statusCode: number,
  ) {
    super(message);
    this.name = "StopMessageError";
  }
}

function isDriverScoped(actor: StopMessageActor): boolean {
  return actor.role === "driver" || Boolean(actor.assistedDriverId);
}

async function conversationContext(stopId: string, actor: StopMessageActor) {
  if (isDriverScoped(actor)) {
    if (!actor.driverProfileId) throw new StopMessageError("Stop not found", 404);
    // Check tenant existence before outgoing-version diagnostics. A foreign
    // identifier must not be treated as a same-tenant handoff needing review.
    const [ownedStop] = await db.select({ id: stopsTable.id }).from(stopsTable).where(and(
      eq(stopsTable.id, stopId),
      eq(stopsTable.organizationId, actor.organizationId),
    )).limit(1);
    if (!ownedStop) throw new StopMessageError("Stop not found", 404);
    const { route } = await outgoingStopContext(actor.organizationId, stopId, actor.driverProfileId);
    return {
      stopId, routeId: route.id, organizationId: actor.organizationId,
      handoffDriverId: route.handoffDriverId, handoffVersion: route.handoffVersion,
      planRevision: route.planRevision,
    };
  }
  if (!["admin", "dispatcher"].includes(actor.role)) {
    throw new StopMessageError("Forbidden: messaging is not available for this role", 403);
  }
  // A working move does not change the recipient of the accepted dispatch.
  // Resolve the same snapshot membership that the driver uses, including
  // when the working stop has been moved to the backlog or another route.
  const [sentMembership] = await db.select({ id: routesTable.id })
    .from(routesTable).innerJoin(routeDispatchSnapshotsTable, and(
      eq(routeDispatchSnapshotsTable.organizationId, routesTable.organizationId),
      eq(routeDispatchSnapshotsTable.routeId, routesTable.id),
      eq(routeDispatchSnapshotsTable.planRevision, routesTable.handoffVersion),
    )).where(and(
      eq(routesTable.organizationId, actor.organizationId),
      sql`${routeDispatchSnapshotsTable.stops} @> ${JSON.stringify([{ id: stopId }])}::jsonb`,
    )).limit(1);
  if (sentMembership) {
    const { route } = await outgoingStopContext(actor.organizationId, stopId, null);
    return {
      stopId, routeId: route.id, organizationId: actor.organizationId,
      handoffDriverId: route.handoffDriverId, handoffVersion: route.handoffVersion,
      planRevision: route.planRevision,
    };
  }
  const [context] = await db
    .select({
      stopId: stopsTable.id,
      routeId: stopsTable.routeId,
      organizationId: stopsTable.organizationId,
      handoffDriverId: routesTable.handoffDriverId,
      handoffVersion: routesTable.handoffVersion,
      planRevision: routesTable.planRevision,
    })
    .from(stopsTable)
    .leftJoin(routesTable, eq(routesTable.id, stopsTable.routeId))
    .where(and(
      eq(stopsTable.id, stopId),
      eq(stopsTable.organizationId, actor.organizationId),
    ))
    .limit(1);
  if (!context || !context.routeId) {
    throw new StopMessageError("Stop not found", 404);
  }
  assertCurrentDriverAssistance(
    { id: context.routeId, ...context, planRevision: context.planRevision ?? -1 },
    actor.assistedRouteId && actor.assistedDriverId
      ? { routeId: actor.assistedRouteId, driverId: actor.assistedDriverId }
      : null,
  );
  if (isDriverScoped(actor) && (
    !actor.driverProfileId
    || context.handoffDriverId !== actor.driverProfileId
  )) {
    // Do not reveal a stop's existence to another tenant's/driver's account.
    throw new StopMessageError("Stop not found", 404);
  }
  if (!["admin", "dispatcher", "driver"].includes(actor.role)) {
    throw new StopMessageError("Forbidden: messaging is not available for this role", 403);
  }
  if (!context.handoffDriverId) {
    throw new StopMessageError("The stop has no dispatched driver", 409);
  }
  return context;
}

async function getOrCreateThread(
  stopId: string,
  actor: StopMessageActor,
  routeId: string,
  driverId: string,
) {
  return db.transaction(async (tx) => {
    if (actor.assistedRouteId && actor.assistedDriverId) {
      const [lockedRoute] = await tx.select({
        id: routesTable.id,
        handoffDriverId: routesTable.handoffDriverId,
        handoffVersion: routesTable.handoffVersion,
        planRevision: routesTable.planRevision,
      }).from(routesTable).where(and(
        eq(routesTable.id, routeId),
        eq(routesTable.organizationId, actor.organizationId),
      )).limit(1).for("update");
      if (!lockedRoute) throw new StopMessageError("Route not found", 404);
      assertCurrentDriverAssistance(lockedRoute, {
        routeId: actor.assistedRouteId,
        driverId: actor.assistedDriverId,
      });
    }
    let [thread] = await tx
      .select()
      .from(stopMessageThreadsTable)
      .where(and(
        eq(stopMessageThreadsTable.organizationId, actor.organizationId),
        eq(stopMessageThreadsTable.stopId, stopId),
      ))
      .limit(1)
      .for("update");
    if (!thread) {
      await tx
        .insert(stopMessageThreadsTable)
        .values({
          organizationId: actor.organizationId,
          routeId,
          stopId,
          driverId,
        })
        .onConflictDoNothing({
          target: [
            stopMessageThreadsTable.organizationId,
            stopMessageThreadsTable.stopId,
          ],
        });
      [thread] = await tx
        .select()
        .from(stopMessageThreadsTable)
        .where(and(
          eq(stopMessageThreadsTable.organizationId, actor.organizationId),
          eq(stopMessageThreadsTable.stopId, stopId),
        ))
        .limit(1)
        .for("update");
    }
    if (!thread || thread.driverId !== driverId || thread.routeId !== routeId) {
      throw new StopMessageError("Stop message thread changed; reload and retry", 409);
    }
    return thread;
  });
}

function isUniqueViolation(error: unknown): boolean {
  const candidate = error as { code?: string; cause?: { code?: string } };
  return candidate.code === "23505" || candidate.cause?.code === "23505";
}

export async function listStopMessages(
  stopId: string,
  actor: StopMessageActor,
  since?: Date,
) {
  const context = await conversationContext(stopId, actor);
  const [thread] = await db
    .select()
    .from(stopMessageThreadsTable)
    .where(and(
      eq(stopMessageThreadsTable.organizationId, actor.organizationId),
      eq(stopMessageThreadsTable.stopId, stopId),
    ))
    .limit(1);
  if (!thread) return { thread: null, messages: [] };
  if (thread.driverId !== context.handoffDriverId || thread.routeId !== context.routeId) {
    throw new StopMessageError("Stop message thread changed; reload and retry", 409);
  }

  const conditions = [
    eq(stopMessagesTable.organizationId, actor.organizationId),
    eq(stopMessagesTable.threadId, thread.id),
  ];
  if (since) conditions.push(gt(stopMessagesTable.createdAt, since));
  const messages = await db
    .select()
    .from(stopMessagesTable)
    .where(and(...conditions))
    .orderBy(asc(stopMessagesTable.createdAt))
    .limit(200);
  if (messages.length === 0) return { thread, messages: [] };
  const receipts = await db
    .select({
      messageId: stopMessageReadReceiptsTable.messageId,
      userId: stopMessageReadReceiptsTable.userId,
      readAt: stopMessageReadReceiptsTable.readAt,
    })
    .from(stopMessageReadReceiptsTable)
    .where(and(
      eq(stopMessageReadReceiptsTable.organizationId, actor.organizationId),
      inArray(stopMessageReadReceiptsTable.messageId, messages.map((message) => message.id)),
    ));
  const receiptByMessage = new Map(
    receipts
      .filter((receipt) => receipt.userId === actor.userId)
      .map((receipt) => [receipt.messageId, receipt.readAt]),
  );
  const receiptsByMessage = new Map<string, Array<{ userId: string; readAt: Date }>>();
  for (const receipt of receipts) {
    const list = receiptsByMessage.get(receipt.messageId) ?? [];
    list.push({ userId: receipt.userId, readAt: receipt.readAt });
    receiptsByMessage.set(receipt.messageId, list);
  }
  return {
    thread: {
      ...thread,
      driverId: context.handoffDriverId,
    },
    messages: messages.map((message) => ({
      ...message,
      readAt: receiptByMessage.get(message.id) ?? null,
      readReceipts: receiptsByMessage.get(message.id) ?? [],
    })),
  };
}

export async function sendStopMessage(args: {
  stopId: string;
  clientMessageId: string;
  body: string;
  actor: StopMessageActor;
}) {
  if (!args.clientMessageId.trim() || args.clientMessageId.length > 200) {
    throw new StopMessageError("clientMessageId is required and must be at most 200 characters", 400);
  }
  const body = args.body.trim();
  if (!body || body.length > 4000) {
    throw new StopMessageError("Message body must contain 1 to 4000 characters", 400);
  }
  const context = await conversationContext(args.stopId, args.actor);
  const existing = await db
    .select()
    .from(stopMessagesTable)
    .where(and(
      eq(stopMessagesTable.organizationId, args.actor.organizationId),
      eq(stopMessagesTable.clientMessageId, args.clientMessageId),
    ))
    .limit(1);
  if (existing[0] && !args.actor.assistedRouteId) {
    if (
      existing[0].body !== body
      || existing[0].senderUserId !== args.actor.userId
    ) {
      throw new StopMessageError("clientMessageId was already used for a different message", 409);
    }
    return { message: existing[0], duplicate: true as const };
  }

  try {
    const thread = await getOrCreateThread(
      args.stopId,
      args.actor,
      context.routeId!,
      context.handoffDriverId!,
    );
    const result = await db.transaction(async (tx) => {
      if (args.actor.assistedRouteId && args.actor.assistedDriverId) {
        const [lockedRoute] = await tx.select({
          id: routesTable.id,
          handoffDriverId: routesTable.handoffDriverId,
          handoffVersion: routesTable.handoffVersion,
          planRevision: routesTable.planRevision,
        }).from(routesTable).where(and(
          eq(routesTable.id, context.routeId!),
          eq(routesTable.organizationId, args.actor.organizationId),
        )).limit(1).for("update");
        if (!lockedRoute) throw new StopMessageError("Route not found", 404);
        assertCurrentDriverAssistance(lockedRoute, {
          routeId: args.actor.assistedRouteId,
          driverId: args.actor.assistedDriverId,
        });
      }
      const [duplicate] = await tx
        .select()
        .from(stopMessagesTable)
        .where(and(
          eq(stopMessagesTable.organizationId, args.actor.organizationId),
          eq(stopMessagesTable.clientMessageId, args.clientMessageId),
        ))
        .limit(1);
      if (duplicate) return { message: duplicate, duplicate: true as const };
      const [message] = await tx
        .insert(stopMessagesTable)
        .values({
          organizationId: args.actor.organizationId,
          threadId: thread.id,
          senderUserId: args.actor.userId,
          senderRole: args.actor.role,
          clientMessageId: args.clientMessageId,
          body,
        })
        .returning();
      if (!message) throw new StopMessageError("Message could not be created", 500);
      await tx
        .insert(stopMessageReadReceiptsTable)
        .values({
          organizationId: args.actor.organizationId,
          messageId: message.id,
          userId: args.actor.userId,
        })
        .onConflictDoNothing({
          target: [
            stopMessageReadReceiptsTable.messageId,
            stopMessageReadReceiptsTable.userId,
          ],
        });
      await tx
        .update(stopMessageThreadsTable)
        .set({ updatedAt: new Date() })
        .where(eq(stopMessageThreadsTable.id, thread.id));
      return { message, duplicate: false as const };
    });
    return result;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const [duplicate] = await db
      .select()
      .from(stopMessagesTable)
      .where(and(
        eq(stopMessagesTable.organizationId, args.actor.organizationId),
        eq(stopMessagesTable.clientMessageId, args.clientMessageId),
      ))
      .limit(1);
    if (!duplicate || duplicate.body !== body || duplicate.senderUserId !== args.actor.userId) {
      throw new StopMessageError("Message changed while retrying; reload and retry", 409);
    }
    return { message: duplicate, duplicate: true as const };
  }
}

export async function markStopMessagesRead(args: {
  stopId: string;
  messageIds?: string[];
  actor: StopMessageActor;
}) {
  const context = await conversationContext(args.stopId, args.actor);
  const [thread] = await db
    .select()
    .from(stopMessageThreadsTable)
    .where(and(
      eq(stopMessageThreadsTable.organizationId, args.actor.organizationId),
      eq(stopMessageThreadsTable.stopId, args.stopId),
    ))
    .limit(1);
  if (!thread) return { marked: 0 };
  const messages = await db
    .select({ id: stopMessagesTable.id })
    .from(stopMessagesTable)
    .where(and(
      eq(stopMessagesTable.organizationId, args.actor.organizationId),
      eq(stopMessagesTable.threadId, thread.id),
      ...(args.messageIds?.length
        ? [inArray(stopMessagesTable.id, args.messageIds)]
        : []),
    ));
  if (messages.length === 0) return { marked: 0 };
  const now = new Date();
  await db.transaction(async (tx) => {
    if (args.actor.assistedRouteId && args.actor.assistedDriverId) {
      const [lockedRoute] = await tx.select({
        id: routesTable.id,
        handoffDriverId: routesTable.handoffDriverId,
        handoffVersion: routesTable.handoffVersion,
        planRevision: routesTable.planRevision,
      }).from(routesTable).where(and(
        eq(routesTable.id, context.routeId!),
        eq(routesTable.organizationId, args.actor.organizationId),
      )).limit(1).for("update");
      if (!lockedRoute) throw new StopMessageError("Route not found", 404);
      assertCurrentDriverAssistance(lockedRoute, {
        routeId: args.actor.assistedRouteId,
        driverId: args.actor.assistedDriverId,
      });
    }
    await tx.insert(stopMessageReadReceiptsTable).values(messages.map((message) => ({
      organizationId: args.actor.organizationId,
      messageId: message.id,
      userId: args.actor.userId,
      readAt: now,
    }))).onConflictDoNothing({
      target: [
        stopMessageReadReceiptsTable.messageId,
        stopMessageReadReceiptsTable.userId,
      ],
    });
  });
  return { marked: messages.length, stopId: context.stopId };
}

/**
 * Route-level compatibility projection for the mobile route conversation
 * surface. The stored conversation remains stop-scoped; callers receive the
 * stop id on every message so no message can be mistaken for another stop.
 */
export async function listRouteMessages(
  routeId: string,
  actor: StopMessageActor,
  since?: Date,
) {
  const [route] = await db
    .select({
      id: routesTable.id,
      organizationId: routesTable.organizationId,
      handoffDriverId: routesTable.handoffDriverId,
      handoffVersion: routesTable.handoffVersion,
      planRevision: routesTable.planRevision,
    })
    .from(routesTable)
    .where(and(
      eq(routesTable.id, routeId),
      eq(routesTable.organizationId, actor.organizationId),
    ))
    .limit(1);
  if (!route) throw new StopMessageError("Route not found", 404);
  assertCurrentDriverAssistance(route, actor.assistedRouteId && actor.assistedDriverId
    ? { routeId: actor.assistedRouteId, driverId: actor.assistedDriverId }
    : null);
  if (isDriverScoped(actor) && route.handoffDriverId !== actor.driverProfileId) {
    throw new StopMessageError("Route not found", 404);
  }
  if (!["admin", "dispatcher", "driver"].includes(actor.role)) {
    throw new StopMessageError("Forbidden: messaging is not available for this role", 403);
  }
  const messagesConditions = [
    eq(routeMessagesTable.organizationId, actor.organizationId),
    eq(routeMessagesTable.routeId, routeId),
  ];
  if (since) messagesConditions.push(gt(routeMessagesTable.createdAt, since));
  const messages = await db
    .select({
      id: routeMessagesTable.id,
      routeId: routeMessagesTable.routeId,
      authorId: routeMessagesTable.senderUserId,
      authorName: usersTable.name,
      body: routeMessagesTable.body,
      createdAt: routeMessagesTable.createdAt,
      clientMessageId: routeMessagesTable.clientMessageId,
    })
    .from(routeMessagesTable)
    .innerJoin(usersTable, eq(usersTable.id, routeMessagesTable.senderUserId))
    .where(and(...messagesConditions))
    .orderBy(since ? asc(routeMessagesTable.createdAt) : desc(routeMessagesTable.createdAt))
    .limit(200);
  // Default polling must include NEW messages after a long conversation.
  // An explicit cursor still retrieves chronological messages after it.
  if (!since) messages.reverse();
  return {
    messages,
    nextCursor: messages.length === 200
      ? messages[messages.length - 1]?.createdAt.toISOString() ?? null
      : null,
  };
}

export async function sendRouteMessage(args: {
  routeId: string;
  clientMessageId: string;
  body: string;
  actor: StopMessageActor;
}) {
  if (!args.clientMessageId.trim() || args.clientMessageId.length > 200) {
    throw new StopMessageError("clientMessageId is required and must be at most 200 characters", 400);
  }
  const body = args.body.trim();
  if (!body || body.length > 4000) {
    throw new StopMessageError("Message body must contain 1 to 4000 characters", 400);
  }
  const [route] = await db
    .select({
      id: routesTable.id,
      handoffDriverId: routesTable.handoffDriverId,
      handoffVersion: routesTable.handoffVersion,
      planRevision: routesTable.planRevision,
    })
    .from(routesTable)
    .where(and(
      eq(routesTable.id, args.routeId),
      eq(routesTable.organizationId, args.actor.organizationId),
    ))
    .limit(1);
  if (!route) throw new StopMessageError("Route not found", 404);
  assertCurrentDriverAssistance(route, args.actor.assistedRouteId && args.actor.assistedDriverId
    ? { routeId: args.actor.assistedRouteId, driverId: args.actor.assistedDriverId }
    : null);
  if (isDriverScoped(args.actor) && route.handoffDriverId !== args.actor.driverProfileId) {
    throw new StopMessageError("Route not found", 404);
  }
  if (!["admin", "dispatcher", "driver"].includes(args.actor.role)) {
    throw new StopMessageError("Forbidden: messaging is not available for this role", 403);
  }
  const [existing] = await db
    .select()
    .from(routeMessagesTable)
    .where(and(
      eq(routeMessagesTable.organizationId, args.actor.organizationId),
      eq(routeMessagesTable.clientMessageId, args.clientMessageId),
    ))
    .limit(1);
  if (existing && !args.actor.assistedRouteId) {
    if (
      existing.routeId !== args.routeId
      || existing.body !== body
      || existing.senderUserId !== args.actor.userId
    ) {
      throw new StopMessageError("clientMessageId was already used for a different message", 409);
    }
    return { message: await routeMessageProjection(existing, args.actor.organizationId), duplicate: true as const };
  }
  try {
    const result = await db.transaction(async (tx) => {
      if (args.actor.assistedRouteId && args.actor.assistedDriverId) {
        const [lockedRoute] = await tx.select({
          id: routesTable.id,
          handoffDriverId: routesTable.handoffDriverId,
          handoffVersion: routesTable.handoffVersion,
          planRevision: routesTable.planRevision,
        }).from(routesTable).where(and(
          eq(routesTable.id, args.routeId),
          eq(routesTable.organizationId, args.actor.organizationId),
        )).limit(1).for("update");
        if (!lockedRoute) throw new StopMessageError("Route not found", 404);
        assertCurrentDriverAssistance(lockedRoute, {
          routeId: args.actor.assistedRouteId,
          driverId: args.actor.assistedDriverId,
        });
      }
      const [message] = await tx
        .insert(routeMessagesTable)
        .values({
          organizationId: args.actor.organizationId,
          routeId: args.routeId,
          senderUserId: args.actor.userId,
          senderRole: args.actor.role,
          clientMessageId: args.clientMessageId,
          body,
        })
        .returning();
      if (!message) throw new StopMessageError("Message could not be created", 500);
      await tx
        .insert(routeMessageReadReceiptsTable)
        .values({
          organizationId: args.actor.organizationId,
          messageId: message.id,
          userId: args.actor.userId,
        })
        .onConflictDoNothing({
          target: [
            routeMessageReadReceiptsTable.messageId,
            routeMessageReadReceiptsTable.userId,
          ],
        });
      return {
        message: await routeMessageProjection(message, args.actor.organizationId),
        duplicate: false as const,
      };
    });
    return result;
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const [duplicate] = await db
      .select()
      .from(routeMessagesTable)
      .where(and(
        eq(routeMessagesTable.organizationId, args.actor.organizationId),
        eq(routeMessagesTable.clientMessageId, args.clientMessageId),
      ))
      .limit(1);
    if (
      !duplicate
      || duplicate.routeId !== args.routeId
      || duplicate.body !== body
      || duplicate.senderUserId !== args.actor.userId
    ) {
      throw new StopMessageError("Message changed while retrying; reload and retry", 409);
    }
    return { message: await routeMessageProjection(duplicate, args.actor.organizationId), duplicate: true as const };
  }
}

async function routeMessageProjection(
  message: typeof routeMessagesTable.$inferSelect,
  organizationId: string,
) {
  const [sender] = await db
    .select({ name: usersTable.name })
    .from(usersTable)
    .where(and(
      eq(usersTable.id, message.senderUserId),
      eq(usersTable.organizationId, organizationId),
    ))
    .limit(1);
  return {
    id: message.id,
    routeId: message.routeId,
    authorId: message.senderUserId,
    authorName: sender?.name ?? "Dispatch",
    body: message.body,
    createdAt: message.createdAt,
    clientMessageId: message.clientMessageId,
  };
}