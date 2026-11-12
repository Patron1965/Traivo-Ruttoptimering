import { Router, type IRouter, type Request } from "express";
import { z } from "zod/v4";
import { getOrgId, requireRole } from "../middleware/auth";
import { handleError, parseUuidParam } from "../lib/errors";
import {
  listStopMessages,
  listRouteMessages,
  markStopMessagesRead,
  sendRouteMessage,
  sendStopMessage,
  StopMessageError,
} from "../services/stop-message-service";
import {
  DriverAssistanceError,
  executionActorForRequest,
  getDriverAssistanceContext,
} from "../lib/driver-assistance";

const router: IRouter = Router();

const MessageBody = z.object({
  clientMessageId: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(4000),
}).strict();

const ReadBody = z.object({
  messageIds: z.array(z.guid()).max(200).optional(),
}).strict();

function actorFor(req: Request) {
  const executionActor = executionActorForRequest(req, getDriverAssistanceContext(req));
  return {
    organizationId: getOrgId(req),
    userId: executionActor.actorUserId,
    // Message attribution remains the authenticated administrator. The
    // assisted driver id is only an ownership scope.
    role: req.user!.role,
    driverProfileId: executionActor.driverProfileId,
    assistedRouteId: executionActor.assistedRouteId,
    assistedDriverId: executionActor.assistedDriverId,
  };
}

router.get(
  "/routes/:routeId/messages",
  requireRole("admin", "dispatcher", "driver"),
  async (req, res) => {
    try {
      const routeId = Array.isArray(req.params.routeId)
        ? req.params.routeId[0]
        : req.params.routeId;
      if (!z.guid().safeParse(routeId).success) {
        res.status(400).json({ error: "Invalid routeId parameter" });
        return;
      }
      const since = typeof req.query.cursor === "string"
        ? new Date(req.query.cursor)
        : undefined;
      if (since && Number.isNaN(since.getTime())) {
        res.status(400).json({ error: "cursor must be a valid ISO timestamp" });
        return;
      }
      res.json(await listRouteMessages(routeId, actorFor(req), since));
    } catch (error) {
      if (error instanceof StopMessageError || error instanceof DriverAssistanceError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      handleError(res, error);
    }
  },
);

router.post(
  "/routes/:routeId/messages",
  requireRole("admin", "dispatcher", "driver"),
  async (req, res) => {
    try {
      const routeId = Array.isArray(req.params.routeId)
        ? req.params.routeId[0]
        : req.params.routeId;
      if (!z.guid().safeParse(routeId).success) {
        res.status(400).json({ error: "Invalid routeId parameter" });
        return;
      }
      const body = MessageBody.parse(req.body ?? {});
      const result = await sendRouteMessage({
        routeId,
        clientMessageId: body.clientMessageId,
        body: body.body,
        actor: actorFor(req),
      });
      res.status(result.duplicate ? 200 : 201).json(result.message);
    } catch (error) {
      if (error instanceof StopMessageError || error instanceof DriverAssistanceError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      handleError(res, error);
    }
  },
);

router.get(
  "/stops/:id/messages",
  requireRole("admin", "dispatcher", "driver"),
  async (req, res) => {
    try {
      const { id } = parseUuidParam(req.params);
      const since = typeof req.query.since === "string"
        ? new Date(req.query.since)
        : undefined;
      if (since && Number.isNaN(since.getTime())) {
        res.status(400).json({ error: "since must be a valid ISO timestamp" });
        return;
      }
      res.json(await listStopMessages(id, actorFor(req), since));
    } catch (error) {
      if (error instanceof StopMessageError || error instanceof DriverAssistanceError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      handleError(res, error);
    }
  },
);

router.post(
  "/stops/:id/messages",
  requireRole("admin", "dispatcher", "driver"),
  async (req, res) => {
    try {
      const { id } = parseUuidParam(req.params);
      const body = MessageBody.parse(req.body ?? {});
      const result = await sendStopMessage({
        stopId: id,
        clientMessageId: body.clientMessageId,
        body: body.body,
        actor: actorFor(req),
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof StopMessageError || error instanceof DriverAssistanceError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      handleError(res, error);
    }
  },
);

router.post(
  "/stops/:id/messages/read",
  requireRole("admin", "dispatcher", "driver"),
  async (req, res) => {
    try {
      const { id } = parseUuidParam(req.params);
      const body = ReadBody.parse(req.body ?? {});
      res.json(await markStopMessagesRead({
        stopId: id,
        messageIds: body.messageIds,
        actor: actorFor(req),
      }));
    } catch (error) {
      if (error instanceof StopMessageError || error instanceof DriverAssistanceError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      handleError(res, error);
    }
  },
);

export default router;