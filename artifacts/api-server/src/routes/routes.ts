import { Router, type IRouter, type Request } from "express";
import { driverArrivals } from "../services/driver-arrival";
import { withStopProofTypes } from "../services/stop-proof-summary";
import {
  CreateRouteBody,
  DispatchRouteBody,
  DispatchRouteResponse,
  ResendRouteSmsBody,
  ResendRouteSmsResponse,
  UpdateRouteBody,
  ListRoutesQueryParams,
  GetRouteAcknowledgementResponse,
  PreviewRouteReoptimizationBody,
  PreviewRouteReoptimizationResponse,
  ApplyRouteReoptimizationBody,
  ApplyRouteReoptimizationResponse,
  SetRoutePlanningLocksBody,
  PreviewRouteAppendImportBody,
  ApplyRouteAppendImportBody,
} from "@workspace/api-zod";
import { setRoutePlanningLocks } from "../services/planning-lock-service";
import { assertOutgoingDispatchCompatible, captureRouteDispatchSnapshot, getRouteDispatchSnapshot } from "../services/route-dispatch-snapshot-service";
import { outgoingRoute } from "../services/outgoing-route-service";
import { projectRouteForMap } from "../services/route-map-projection";
import { handleError, parseUuidParam } from "../lib/errors";
import { assertOrgScope, getOrgId, requireRole } from "../middleware/auth";
import { requireRouteReadAccess } from "../middleware/field-service-read-access";
import * as routeService from "../services/route-service";
import {
  db,
  routesTable,
  routeExecutionsTable,
  driversTable,
  vehiclesTable,
  stopsTable,
  routeIncidentsTable,
} from "@workspace/db";
import { eq, and, sql, isNull } from "drizzle-orm";
import { z } from "zod/v4";
import { sendPushNotification } from "../services/push-service";
import { dispatchWebhookEvent } from "../services/webhooks";
import { isSmsConfigured, sendSms } from "../services/sms";
import { assertDriverEligibleForFieldServiceStops } from "../services/field-service";
import * as routeAcknowledgementService from "../services/route-acknowledgement-service";
import { broadcastDataChange } from "../services/realtime";
import { broadcastTenantEvent } from "../ws";
import {
  applyRouteScopedReoptimization,
  ImportRouteWorkflowError,
  previewRouteScopedReoptimization,
  previewRouteAppendImport,
  applyRouteAppendImport,
} from "../services/import-route-workflow";
import { notifyDriverRouteChanged } from "../services/route-notification-service";
import {
  assertProtectedRouteDispatchApproval,
  lockApprovalResources,
  RoutePlanApprovalError,
} from "../services/route-plan-approval-service";
import {
  buildRouteDriverAppUrl,
  buildRouteDriverSmsMessage,
  resendRouteSms,
} from "../services/route-sms";
import rateLimit from "express-rate-limit";
import { logRouteSmsResendEvent } from "../lib/security-log";
import {
  assertCurrentDriverAssistance,
  DriverAssistanceError,
  getDriverAssistanceContext,
  validateDriverAssistanceContext,
} from "../lib/driver-assistance";

const router: IRouter = Router();
router.post("/routes/:id/import-stops/preview", requireRole("admin", "dispatcher"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const input = PreviewRouteAppendImportBody.parse(req.body);
    res.json(await previewRouteAppendImport(getOrgId(req), id, input));
  } catch (error) {
    if (error instanceof ImportRouteWorkflowError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code, details: error.details });
      return;
    }
    handleError(res, error);
  }
});
router.post("/routes/:id/import-stops/apply", requireRole("admin", "dispatcher"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const input = ApplyRouteAppendImportBody.parse(req.body);
    res.json(await applyRouteAppendImport(getOrgId(req), id, input));
  } catch (error) {
    if (error instanceof ImportRouteWorkflowError) {
      res.status(error.statusCode).json({ error: error.message, code: error.code, details: error.details });
      return;
    }
    handleError(res, error);
  }
});
const HandoffBody = z.object({
  status: z.enum(["received", "opened", "accepted", "rejected"]),
  version: z.number().int().nonnegative(),
  reason: z.string().trim().min(1).max(1000).optional(),
}).strict();
type CurrentHandoffStatus = "sent" | "received" | "opened" | "accepted" | "rejected";
const CURRENT_HANDOFF_STATUSES: ReadonlySet<CurrentHandoffStatus> = new Set([
  "sent",
  "received",
  "opened",
  "accepted",
  "rejected",
] as const);
function isCurrentHandoffStatus(status: string): status is CurrentHandoffStatus {
  return CURRENT_HANDOFF_STATUSES.has(status as CurrentHandoffStatus);
}
const IncidentBody = z.object({
  category: z.enum(["traffic", "vehicle_issue", "accident", "customer_unavailable", "access_problem", "weather", "safety", "other"]),
  comment: z.string().trim().min(1).max(4000),
  attachmentUrl: z.string().url().max(2048).refine(
    (value) => new URL(value).protocol === "https:",
    { message: "attachmentUrl must use HTTPS" },
  ).optional(),
}).strict();
const BulkDeleteRoutesBody = z.object({
  routeIds: z.array(z.guid()).min(1).max(500),
  confirmLiveRouteRemoval: z.boolean(),
}).strict().superRefine((value, context) => {
  if (new Set(value.routeIds.map((routeId) => routeId.toLowerCase())).size !== value.routeIds.length) {
    context.addIssue({
      code: "custom",
      path: ["routeIds"],
      message: "routeIds must contain unique UUIDs",
    });
  }
});
const DeleteRouteBody = z.object({
  confirmLiveRouteRemoval: z.boolean(),
}).strict();
const LockedFirstStopBody = z.object({
  stopId: z.guid().nullable(),
  planRevision: z.number().int().nonnegative(),
}).strict();

const resendSmsRateLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 3,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => `${req.user?.organizationId ?? "unknown"}:${String(req.params.id)}`,
  handler: (req, res) => {
    void logRouteSmsResendEvent({
      req,
      routeId: typeof req.params.id === "string" ? req.params.id : null,
      statusCode: 429,
      code: "resend_rate_limited",
      outcome: "rate_limited",
    });
    res.status(429).json({
      error: "För många SMS-försök. Försök igen senare.",
      code: "resend_rate_limited",
    });
  },
});

export function isValidHandoffTransition(current: string, next: "received" | "opened" | "accepted" | "rejected"): boolean {
  return ({ received: ["sent"], opened: ["received"], accepted: ["opened"], rejected: ["opened"] })[next].includes(current);
}

async function driverOwnedRoute(req: Request, routeId: string) {
  const assistance = getDriverAssistanceContext(req);
  const driverProfileId = assistance?.driverId ?? req.user?.driverProfileId;
  if ((req.user?.role !== "driver" && !assistance) || !driverProfileId) return null;
  const [row] = await db.select({ route: routesTable }).from(routesTable)
    .innerJoin(driversTable, and(
      eq(driversTable.id, driverProfileId),
      eq(driversTable.organizationId, req.user!.organizationId),
      eq(driversTable.isActive, true),
      eq(routesTable.handoffDriverId, driverProfileId),
    ))
    .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, req.user!.organizationId)));
  if (row?.route) assertCurrentDriverAssistance(row.route, assistance);
  return row?.route ? outgoingRoute(row.route) : null;
}

router.get("/routes", async (req, res) => {
  try {
    const { organizationId, status } = ListRoutesQueryParams.parse(req.query);
    const orgId = assertOrgScope(req, organizationId);
    const assistance = await validateDriverAssistanceContext(req);
    if (assistance) {
      const route = await routeService.getRoute(assistance.routeId, orgId);
      const projected = route ? await outgoingRoute(route) : null;
      res.json(projected && (!status || projected.status === status) ? [projectRouteForMap(projected)] : []);
      return;
    }
    const routes = await routeService.listRoutes(orgId, status, req.user);
    res.json(routes.map(projectRouteForMap));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id", requireRouteReadAccess(), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const route = await routeService.getRoute(id, orgId);
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(projectRouteForMap(req.user!.role === "driver" || getDriverAssistanceContext(req) ? await outgoingRoute(route) : route));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id/dispatch-snapshot", requireRole("admin", "dispatcher", "driver"), requireRouteReadAccess(), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const result = await getRouteDispatchSnapshot(getOrgId(req), id);
    if (!result) { res.status(404).json({ error: "Route not found" }); return; }
    if (req.user!.role === "driver" && result.driverId !== req.user!.driverProfileId) {
      res.status(404).json({ error: "Route not found" }); return;
    }
    res.json(result);
  } catch (err) { handleError(res, err); }
});

router.put("/routes/:id/planning-locks", requireRole("admin", "dispatcher"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    if (req.body?.serviceStartAt != null) {
      z.string().datetime({ offset: true }).parse(req.body.serviceStartAt);
    }
    const input = SetRoutePlanningLocksBody.strict().parse(req.body);
    const result = await setRoutePlanningLocks(getOrgId(req), id, input, {
      userId: req.user!.id, userEmail: req.user!.email,
    });
    if (!result) { res.status(404).json({ error: "Route not found" }); return; }
    res.json(result);
  } catch (err) { handleError(res, err); }
});

router.put(
  "/routes/:id/locked-first-stop",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    try {
      const { id } = parseUuidParam(req.params);
      const input = LockedFirstStopBody.parse(req.body);
      const route = await routeService.setLockedFirstStop(
        id,
        getOrgId(req),
        input.stopId,
        input.planRevision,
        {
          userId: req.user?.id ?? null,
          userEmail: req.user?.email ?? null,
        },
      );
      if (!route) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
      res.json(route);
    } catch (error) {
      handleError(res, error);
    }
  },
);

router.post(
  "/routes/:id/reoptimization/preview",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const { id } = parseUuidParam(req.params);
    const parsed = PreviewRouteReoptimizationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const result = await previewRouteScopedReoptimization(getOrgId(req), id, parsed.data);
      res.json(PreviewRouteReoptimizationResponse.parse(result));
    } catch (error) {
      if (error instanceof ImportRouteWorkflowError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/routes/:id/reoptimization/apply",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const { id } = parseUuidParam(req.params);
    const parsed = ApplyRouteReoptimizationBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }
    try {
      const result = await applyRouteScopedReoptimization(getOrgId(req), id, parsed.data);
      res.json(ApplyRouteReoptimizationResponse.parse(result));
    } catch (error) {
      if (error instanceof ImportRouteWorkflowError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.post("/routes/:id/handoff", requireRole("admin", "driver"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const input = HandoffBody.parse(req.body);
    if ((input.status === "rejected") !== (input.reason !== undefined)) {
      res.status(400).json({ error: input.status === "rejected" ? "A rejection reason is required" : "reason is only valid when rejecting a route" });
      return;
    }
    const assistance = getDriverAssistanceContext(req);
    const route = await driverOwnedRoute(req, id);
    if (!route) { res.status(404).json({ error: "Route not found" }); return; }
    if (route.handoffVersion !== input.version) { res.status(409).json({ error: "Route handoff version is stale" }); return; }
    if (route.handoffStatus === input.status) {
      if (input.status !== "rejected" || route.rejectionReason === input.reason) {
        if (!assistance) { res.json(route); return; }
        const locked = await db.transaction(async (tx) => {
          const [current] = await tx.select().from(routesTable).where(and(
            eq(routesTable.id, id),
            eq(routesTable.organizationId, req.user!.organizationId),
          )).limit(1).for("update");
          if (!current) return null;
          assertCurrentDriverAssistance(current, assistance);
          return current;
        });
        if (!locked) { res.status(409).json({ error: "Route handoff state changed; reload and retry" }); return; }
        res.json(await outgoingRoute(locked));
        return;
      }
      res.status(409).json({ error: "Route was already rejected with a different reason" }); return;
    }
    if (!isValidHandoffTransition(route.handoffStatus, input.status)) {
      res.status(409).json({ error: `Invalid handoff transition from ${route.handoffStatus} to ${input.status}` }); return;
    }
    const now = new Date();
    const timestampField = `${input.status}At` as "receivedAt" | "openedAt" | "acceptedAt" | "rejectedAt";
    const updated = await db.transaction(async (tx) => {
      const [locked] = await tx.select().from(routesTable).where(and(
        eq(routesTable.id, id), eq(routesTable.organizationId, req.user!.organizationId),
      )).limit(1).for("update");
      if (!locked) return null;
      assertCurrentDriverAssistance(locked, assistance);
      if (
        locked.handoffDriverId !== route.handoffDriverId
        || locked.handoffVersion !== input.version
        || locked.handoffStatus !== route.handoffStatus
      ) return null;
      const [next] = await tx.update(routesTable).set({
        handoffStatus: input.status, [timestampField]: now,
        rejectionReason: input.status === "rejected" ? input.reason : null, updatedAt: now,
      }).where(and(
        eq(routesTable.id, id), eq(routesTable.organizationId, req.user!.organizationId),
        eq(routesTable.handoffVersion, input.version), eq(routesTable.handoffStatus, route.handoffStatus),
      )).returning();
      return next ?? null;
    });
    if (!updated) { res.status(409).json({ error: "Handoff state changed; reload and retry" }); return; }
    broadcastDataChange(updated.organizationId, "route", "updated", { id, handoffStatus: updated.handoffStatus });
    dispatchWebhookEvent(updated.organizationId, `route.handoff.${input.status}`, { routeId: id, status: input.status, version: input.version }).catch(() => {});
    res.json(await outgoingRoute(updated));
  } catch (err) {
    if (err instanceof DriverAssistanceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

router.post("/routes/:id/incidents", requireRole("admin", "driver"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const input = IncidentBody.parse(req.body);
    const route = await driverOwnedRoute(req, id);
    if (!route) { res.status(404).json({ error: "Route not found" }); return; }
    const assistance = getDriverAssistanceContext(req);
    const incident = await db.transaction(async (tx) => {
      const [lockedRoute] = await tx.select().from(routesTable).where(and(
        eq(routesTable.id, id),
        eq(routesTable.organizationId, req.user!.organizationId),
      )).limit(1).for("update");
      if (!lockedRoute) return null;
      assertCurrentDriverAssistance(lockedRoute, assistance);
      if (!assistance && lockedRoute.handoffDriverId !== req.user!.driverProfileId) return null;
      const [created] = await tx.insert(routeIncidentsTable).values({
        ...input, routeId: id, organizationId: req.user!.organizationId,
        driverId: assistance?.driverId ?? req.user!.driverProfileId!,
      }).returning();
      return created ?? null;
    });
    if (!incident) { res.status(409).json({ error: "Route assignment changed; reload and retry" }); return; }
    broadcastDataChange(route.organizationId, "route", "updated", { id, incidentId: incident.id });
    dispatchWebhookEvent(route.organizationId, "route.incident.created", { routeId: id, incidentId: incident.id, category: incident.category }).catch(() => {});
    res.status(201).json(incident);
  } catch (err) {
    if (err instanceof DriverAssistanceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

router.get("/routes/:id/incidents", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    if (req.user!.role === "driver" || getDriverAssistanceContext(req)) {
      if (!await driverOwnedRoute(req, id)) { res.status(404).json({ error: "Route not found" }); return; }
    } else if (!["admin", "dispatcher"].includes(req.user!.role) || !await routeService.getRoute(id, orgId)) {
      res.status(404).json({ error: "Route not found" }); return;
    }
    res.json(await db.select().from(routeIncidentsTable)
      .where(and(eq(routeIncidentsTable.routeId, id), eq(routeIncidentsTable.organizationId, orgId)))
      .orderBy(routeIncidentsTable.createdAt));
  } catch (err) {
    if (err instanceof DriverAssistanceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

router.post("/routes", async (req, res) => {
  try {
    const data = CreateRouteBody.parse(req.body);
    data.organizationId = assertOrgScope(req, data.organizationId);
    const route = await routeService.createRoute(data);
    res.status(201).json(route);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/routes/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const blockedPlanningFields = [
      "vehicleId",
      "date",
      "totalStops",
      "totalDistanceKm",
      "totalDurationMin",
      "co2EmissionsKg",
    ];
    if (blockedPlanningFields.some((field) =>
      Object.prototype.hasOwnProperty.call(req.body ?? {}, field)
    )) {
      res.status(409).json({
        error: "Planning fields must use an atomic planning or dispatch operation.",
      });
      return;
    }
    const expectedPlanRevision = req.body?.planRevision;
    if (
      Object.prototype.hasOwnProperty.call(req.body ?? {}, "status") &&
      (!Number.isInteger(expectedPlanRevision) || expectedPlanRevision < 0)
    ) {
      res.status(400).json({
        error: "planRevision is required for route status changes.",
      });
      return;
    }
    const data = UpdateRouteBody.parse(req.body);
    delete (data as Record<string, unknown>).planRevision;
    const notifyFields: Record<string, boolean> = {};
    if (typeof req.body.notifyApproaching === "boolean") notifyFields.notifyApproaching = req.body.notifyApproaching;
    if (typeof req.body.notifyDelivered === "boolean") notifyFields.notifyDelivered = req.body.notifyDelivered;
    if (typeof req.body.notifyFailed === "boolean") notifyFields.notifyFailed = req.body.notifyFailed;

    const orgId = getOrgId(req);
    const route = await routeService.updateRoute(
      id,
      orgId,
      data,
      notifyFields,
      expectedPlanRevision,
    );
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(route);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/routes/bulk-delete", requireRole("admin", "dispatcher"), async (req, res) => {
  const parsed = BulkDeleteRoutesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: "routeIds must be an array of 1 to 500 unique UUIDs", details: parsed.error.issues });
    return;
  }
  try {
    const result = await routeService.deleteRoutes(
      parsed.data.routeIds,
      getOrgId(req),
      parsed.data.confirmLiveRouteRemoval,
    );
    res.json(result);
  } catch (err) {
    if (err instanceof routeService.RouteDeleteConflictError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        details: { conflicts: err.conflicts },
      });
      return;
    }
    if (err instanceof routeService.RouteDeleteNotFoundError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

router.delete("/routes/:id", requireRole("admin", "dispatcher"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const parsed = DeleteRouteBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "confirmLiveRouteRemoval must be a boolean" });
      return;
    }
    const orgId = getOrgId(req);
    const deleted = await routeService.deleteRoute(
      id,
      orgId,
      parsed.data.confirmLiveRouteRemoval,
    );
    if (!deleted) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    if (err instanceof routeService.RouteDeleteConflictError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        details: { conflicts: err.conflicts },
      });
      return;
    }
    if (err instanceof routeService.RouteDeleteNotFoundError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

router.get("/routes/:id/stops", requireRouteReadAccess(), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const stops = await routeService.getRouteStops(id, orgId, req.user);
    if (!stops) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    const arrivals = await driverArrivals(id, orgId, stops);
    const summaries = await withStopProofTypes(stops, orgId, req.user?.role);
    res.json(summaries.map(stop => ({ ...stop, arrival: arrivals[stop.id] ?? null })));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id/preflight", requireRouteReadAccess(), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const [route] = await db.select().from(routesTable)
      .where(and(eq(routesTable.id, id), eq(routesTable.organizationId, orgId)));
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    const issues: Array<{ code: string; message: string }> = [];
    if (!route.vehicleId) {
      issues.push({ code: "missing_vehicle", message: "Fordon saknas." });
    }
    const [vehicle] = route.vehicleId
      ? await db.select().from(vehiclesTable).where(and(
          eq(vehiclesTable.id, route.vehicleId),
          eq(vehiclesTable.organizationId, orgId),
          eq(vehiclesTable.isActive, true),
        ))
      : [];
    if (route.vehicleId && !vehicle) {
      issues.push({ code: "inactive_vehicle", message: "Tilldelat fordon är inte aktivt." });
    }
    const [driver] = route.vehicleId
      ? await db.select().from(driversTable).where(and(
          eq(driversTable.vehicleId, route.vehicleId),
          eq(driversTable.organizationId, orgId),
          eq(driversTable.isActive, true),
        ))
      : [];
    if (!driver) {
      issues.push({ code: "missing_driver", message: "Aktiv chaufför saknas." });
    }
    const routeStops = await db.select().from(stopsTable).where(and(
      eq(stopsTable.routeId, id),
      eq(stopsTable.organizationId, orgId),
      isNull(stopsTable.archivedAt),
    ));
    if (routeStops.length === 0) {
      issues.push({ code: "missing_stops", message: "Rutten saknar stopp." });
    }
    if (routeStops.some((stop) =>
      !Number.isFinite(stop.latitude) ||
      !Number.isFinite(stop.longitude) ||
      stop.latitude < -90 ||
      stop.latitude > 90 ||
      stop.longitude < -180 ||
      stop.longitude > 180
    )) {
      issues.push({ code: "invalid_coordinates", message: "Ett eller flera stopp saknar giltiga koordinater." });
    }
    if (route.manualReviewRequired && !route.manualReviewedAt && !route.draftId) {
      issues.push({ code: "review_required", message: "Planversionen är inte sparad och validerad." });
    }
    res.json({
      routeId: route.id,
      planId: route.planId,
      planRevision: route.planRevision,
      ready: issues.length === 0,
      driverId: driver?.id ?? null,
      issues,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id/export", requireRole("admin", "dispatcher"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const result = await routeService.exportRoute(id, orgId);
    if (!result) {
      res.status(404).json({ error: "Route not found" });
      return;
    }

    const { route, vehicleName, stops } = result;
    const lines = [
      "Sequence,Address,Latitude,Longitude,Time Window Start,Time Window End,Service Duration (min),Weight (kg),Notes",
    ];
    for (const stop of stops) {
      lines.push(
        [
          stop.sequenceOrder ?? "",
          `"${(stop.address || "").replace(/"/g, '""')}"`,
          stop.latitude,
          stop.longitude,
          stop.timeWindowStart ? stop.timeWindowStart.toISOString() : "",
          stop.timeWindowEnd ? stop.timeWindowEnd.toISOString() : "",
          stop.serviceDurationMin,
          stop.weightKg ?? "",
          `"${(stop.notes || "").replace(/"/g, '""')}"`,
        ].join(",")
      );
    }

    const header = `# Route: ${route.name}\n# Vehicle: ${vehicleName}\n# Distance: ${route.totalDistanceKm ?? 0} km\n# Duration: ${route.totalDurationMin ?? 0} min\n# CO2: ${route.co2EmissionsKg ?? 0} kg\n# Stops: ${route.totalStops}\n`;
    const csv = header + lines.join("\n");
    res.setHeader("Content-Type", "text/csv");
    res.setHeader("Content-Disposition", `attachment; filename="route-${route.name.replace(/[^a-zA-Z0-9]/g, "-")}.csv"`);
    res.send(csv);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/routes/:id/reorder-stops", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const { stopIds, planRevision } = req.body as {
      stopIds: string[];
      planRevision: number;
    };
    if (!Array.isArray(stopIds) || stopIds.length === 0) {
      res.status(400).json({ error: "stopIds array is required" });
      return;
    }
    if (!Number.isInteger(planRevision) || planRevision < 0) {
      res.status(400).json({ error: "planRevision is required" });
      return;
    }
    const result = await routeService.reorderStops(
      id,
      orgId,
      stopIds,
      planRevision,
    );
    if ("error" in result && typeof result.status === "number") {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.data);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/routes/:id/reschedule-failed", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const result = await routeService.rescheduleFailedStops(id, orgId);
    if ("error" in result && typeof result.status === "number") {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json(result.data);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id/comparison", requireRouteReadAccess(), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const comparison = await routeService.getRouteComparison(id, orgId);
    if (!comparison) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(comparison);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/routes/:id/dispatch", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const input = DispatchRouteBody.parse(req.body ?? {});
    const expectedWorkingRevision = req.body?.planRevision === undefined
      ? undefined : z.number().int().nonnegative().parse(req.body.planRevision);

    let [route] = await db
      .select()
      .from(routesTable)
      .where(and(eq(routesTable.id, id), eq(routesTable.organizationId, orgId)));

    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    if (expectedWorkingRevision !== undefined && route.planRevision !== expectedWorkingRevision) {
      res.status(409).json({ error: "Arbetsplanens version har ändrats. Granska och godkänn aktuell version före utskick.", code: "STALE_PLAN_REVISION" });
      return;
    }

    if (!route.vehicleId) {
      res.status(404).json({ error: "Rutten har ingen tilldelad bil eller chaufför." });
      return;
    }
    const originalVehicleId = route.vehicleId;
    const [activeVehicle] = await db.select({ id: vehiclesTable.id }).from(vehiclesTable).where(and(
      eq(vehiclesTable.id, route.vehicleId),
      eq(vehiclesTable.organizationId, orgId),
      eq(vehiclesTable.isActive, true),
    ));
    if (!activeVehicle) {
      res.status(409).json({ error: "Preflight misslyckades: ruttens fordon är inte aktivt." });
      return;
    }

    if (route.manualReviewRequired && !route.manualReviewedAt && !route.draftId) {
      res.status(409).json({
        error: "Ruttplanen måste granskas och valideras innan den kan skickas.",
      });
      return;
    }

    let [driver] = await db
      .select()
      .from(driversTable)
      .where(
        and(
          eq(driversTable.id, input.driverId),
          eq(driversTable.vehicleId, route.vehicleId),
          eq(driversTable.organizationId, orgId),
          eq(driversTable.isActive, true),
        ),
      );

    if (!driver) {
      res.status(404).json({
        error: "Den valda chauffören är inte aktiv eller är inte längre kopplad till ruttens bil.",
      });
      return;
    }

    const routeStops = await db
      .select()
      .from(stopsTable)
      .where(
        and(
          eq(stopsTable.routeId, route.id),
          eq(stopsTable.organizationId, orgId),
          isNull(stopsTable.archivedAt),
        ),
      )
    if (routeStops.length === 0 || routeStops.some((stop) =>
      !Number.isFinite(stop.latitude) ||
      !Number.isFinite(stop.longitude) ||
      stop.latitude < -90 ||
      stop.latitude > 90 ||
      stop.longitude < -180 ||
      stop.longitude > 180
    )) {
      res.status(409).json({ error: "Preflight misslyckades: rutten saknar stopp eller har ogiltiga koordinater." });
      return;
    }

    /*
     * The approval check must share the row lock and CAS that publishes the
     * handoff.  The earlier preflight is only a user-facing fast failure; it
     * is never an authorization decision.
     */
    const dispatchResult = await db.transaction(async (tx) => {
      const resources = await lockApprovalResources(
        tx,
        orgId,
        [id],
        [input.driverId],
      );
      const [lockedRoute] = resources.routes;
      if (!lockedRoute) return null;
      if (lockedRoute.planRevision !== route.planRevision || lockedRoute.vehicleId !== originalVehicleId) {
        throw new RoutePlanApprovalError("Arbetsplanen ändrades efter preflight. Granska och skicka igen.", 409, "STALE_PLAN_REVISION");
      }
      const lockedDriver = resources.drivers.find((candidate) =>
        candidate.id === input.driverId
        && candidate.vehicleId === lockedRoute.vehicleId
        && candidate.isActive,
      );
      const lockedVehicle = resources.vehicles.find((candidate) =>
        candidate.id === lockedRoute.vehicleId
        && candidate.isActive,
      );
      if (!lockedVehicle || !lockedDriver) {
        throw new RoutePlanApprovalError(
          "The selected driver or vehicle is no longer active and linked to this route.",
          409,
          "INVALID_RECIPIENT",
        );
      }
      if (
        resources.stops.length === 0
        || resources.stops.some((stop) =>
          !Number.isFinite(stop.latitude)
          || !Number.isFinite(stop.longitude)
          || stop.latitude < -90
          || stop.latitude > 90
          || stop.longitude < -180
          || stop.longitude > 180
        )
      ) {
        const error = new Error(
          "Preflight misslyckades: rutten saknar stopp eller har ogiltiga koordinater.",
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }
      if (lockedRoute.status === "completed" || lockedRoute.status === "cancelled") {
        const error = new Error(
          "Completed or cancelled routes cannot be dispatched.",
        ) as Error & { statusCode: number };
        error.statusCode = 409;
        throw error;
      }

      await assertProtectedRouteDispatchApproval(
        tx,
        orgId,
        lockedRoute,
        resources,
        lockedDriver.id,
      );
      await assertOutgoingDispatchCompatible(tx, lockedRoute, resources.stops);
      await assertDriverEligibleForFieldServiceStops(
        orgId,
        lockedRoute.id,
        lockedDriver.id,
        lockedVehicle.id,
        new Date(),
        tx,
      );

      const [currentExecution] = await tx
        .select({ driverId: routeExecutionsTable.driverId })
        .from(routeExecutionsTable)
        .where(and(
          eq(routeExecutionsTable.organizationId, orgId),
          eq(routeExecutionsTable.routeId, lockedRoute.id),
          eq(routeExecutionsTable.planVersion, lockedRoute.planRevision),
        ))
        .limit(1)
        .for("update");
      if (currentExecution && currentExecution.driverId !== lockedDriver.id) {
        throw new RoutePlanApprovalError(
          "The current route execution is assigned to another driver; create a new plan revision before changing the recipient.",
          409,
        );
      }

      /*
       * A dispatch request can be retried after the client loses the HTTP
       * response.  Once the route row says that the exact current plan was
       * handed to this exact recipient, the handoff is already published.
       * Return that row rather than resetting receipt/acceptance timestamps or
       * sending another notification.  This check deliberately lives after
       * the route/resource locks above so concurrent requests cannot both
       * publish the same handoff.
       */
      if (
        lockedRoute.status === "in_progress"
        && isCurrentHandoffStatus(lockedRoute.handoffStatus)
        && lockedRoute.handoffVersion === lockedRoute.planRevision
        && lockedRoute.handoffDriverId === lockedDriver.id
        && lockedRoute.dispatchSnapshotVersion === lockedRoute.planRevision
      ) {
        return {
          route: lockedRoute,
          driver: lockedDriver,
          isFirstDispatch: false,
          isIdempotent: true,
        };
      }

      const isFirstDispatch = lockedRoute.status !== "in_progress";
      const now = new Date();
      if (isFirstDispatch) {
        const transitionConditions = [
          eq(routesTable.id, id),
          eq(routesTable.organizationId, orgId),
          eq(routesTable.status, route.status),
          eq(routesTable.planRevision, route.planRevision),
          eq(routesTable.vehicleId, originalVehicleId),
          ...(lockedRoute.manualReviewRequired && !lockedRoute.draftId
            ? [sql`${routesTable.manualReviewedAt} is not null`]
            : []),
          sql`exists (
            select 1 from ${vehiclesTable}
            where ${vehiclesTable.id} = ${routesTable.vehicleId}
              and ${vehiclesTable.organizationId} = ${orgId}
              and ${vehiclesTable.isActive} = true
          )`,
          sql`exists (
            select 1 from ${driversTable}
            where ${driversTable.id} = ${input.driverId}
              and ${driversTable.vehicleId} = ${routesTable.vehicleId}
              and ${driversTable.organizationId} = ${orgId}
              and ${driversTable.isActive} = true
          )`,
          sql`exists (
            select 1 from ${stopsTable}
            where ${stopsTable.routeId} = ${routesTable.id}
              and ${stopsTable.organizationId} = ${orgId}
                and ${stopsTable.archivedAt} is null
          )`,
          sql`not exists (
            select 1 from ${stopsTable}
            where ${stopsTable.routeId} = ${routesTable.id}
              and ${stopsTable.organizationId} = ${orgId}
                and ${stopsTable.archivedAt} is null
              and (
                ${stopsTable.latitude} is null
                or ${stopsTable.longitude} is null
                or ${stopsTable.latitude} not between -90 and 90
                or ${stopsTable.longitude} not between -180 and 180
              )
          )`,
        ];
        const [publishedRoute] = await tx
          .update(routesTable)
          .set({
            status: "in_progress",
            handoffStatus: "sent",
            handoffVersion: lockedRoute.planRevision,
            handoffDriverId: lockedDriver.id,
            sentAt: now,
            receivedAt: null,
            openedAt: null,
            acceptedAt: null,
            rejectedAt: null,
            rejectionReason: null,
            updatedAt: now,
          })
          .where(and(...transitionConditions))
          .returning();
        const capturedRoute = publishedRoute
          ? await captureRouteDispatchSnapshot(tx, publishedRoute, resources.stops, lockedDriver.id, now)
          : null;
        return capturedRoute
          ? {
              route: capturedRoute,
              driver: lockedDriver,
              isFirstDispatch: true,
              isIdempotent: false,
            }
          : null;
      }

      const [resentRoute] = await tx
        .update(routesTable)
        .set({
          handoffStatus: "sent",
          handoffVersion: lockedRoute.planRevision,
          handoffDriverId: driver.id,
          sentAt: now,
          receivedAt: null,
          openedAt: null,
          acceptedAt: null,
          rejectedAt: null,
          rejectionReason: null,
          updatedAt: now,
        })
        .where(and(
          eq(routesTable.id, id),
          eq(routesTable.organizationId, orgId),
          eq(routesTable.status, route.status),
          eq(routesTable.planRevision, route.planRevision),
          eq(routesTable.vehicleId, originalVehicleId),
          eq(routesTable.handoffStatus, route.handoffStatus),
          route.handoffVersion == null
            ? sql`${routesTable.handoffVersion} is null`
            : eq(routesTable.handoffVersion, route.handoffVersion),
          route.handoffDriverId == null
            ? sql`${routesTable.handoffDriverId} is null`
            : eq(routesTable.handoffDriverId, route.handoffDriverId),
        ))
        .returning();
      const capturedResentRoute = resentRoute
        ? await captureRouteDispatchSnapshot(tx, resentRoute, resources.stops, lockedDriver.id, now)
        : null;
      return capturedResentRoute
        ? {
            route: capturedResentRoute,
            driver: lockedDriver,
            isFirstDispatch: false,
            isIdempotent: false,
          }
        : null;
    });

    if (!dispatchResult) {
      res.status(409).json({
        error: "Ruttplanen, fordonet eller chauffören ändrades efter preflight. Validera planen på nytt innan utskick.",
      });
      return;
    }
    route = dispatchResult.route;
    driver = dispatchResult.driver ?? driver;
    const isFirstDispatch = dispatchResult.isFirstDispatch;
    if (dispatchResult.isIdempotent) {
      res.json(
        DispatchRouteResponse.parse({
          ok: false,
          routeId: id,
          status: "in_progress",
          sms: {
            status: "unknown",
            sent: false,
            message: "Rutten är redan utskickad. SMS skickades inte igen.",
          },
        }),
      );
      return;
    }
    // New stops in an approved redispatch also need their first notification.
    // The sender's per-stop event/channel claim suppresses repeats.
    const { notifyRouteCustomers } = await import("../services/customer-notifications");
    void notifyRouteCustomers(route.id, orgId, "planned");
    if (isFirstDispatch) {
      dispatchWebhookEvent(orgId, "route.dispatched", {
        routeId: route.id,
        routeName: route.name,
        status: "in_progress",
        handoffStatus: "sent",
        handoffVersion: route.planRevision,
        handoffDriverId: driver.id,
      }).catch(() => {});
    }
    broadcastDataChange(orgId, "route", "updated", { id, status: "in_progress", handoffStatus: "sent" });

    await routeAcknowledgementService.recordRouteSent(
      orgId,
      route.id,
      driver.id,
    );
    await notifyDriverRouteChanged({
      organizationId: orgId,
      routeId: route.id,
      driverId: driver.id,
      planVersion: route.planRevision,
      message: `Route ${route.name} is ready in the driver app.`,
    });

    const countText = route.totalStops > 0 ? ` (${route.totalStops} stopp)` : "";
    if (isFirstDispatch && driver.expoPushToken) {
      await sendPushNotification(
        driver.expoPushToken,
        "Ny rutt tilldelad",
        `${route.name}${countText} — tryck för att öppna.`,
        { routeId: route.id, type: "route_assigned" },
      );
    }
    if (!isFirstDispatch && driver.expoPushToken) {
      await sendPushNotification(
        driver.expoPushToken,
        "Rutt uppdaterad",
        `${route.name}${countText} — granska och acceptera den nya versionen.`,
        {
          routeId: route.id,
          type: "route_changed",
          planVersion: route.planRevision,
          reason: "redispatched",
        },
      );
    }

    const driverAppUrl = buildRouteDriverAppUrl({
      configuredUrl: process.env.DRIVER_APP_URL,
      requestOrigin: `${req.protocol}://${req.get("host")}`,
      routeId: route.id,
    });

    let sms: {
      status: "sent" | "not_configured" | "missing_phone" | "failed" | "skipped";
      sent: boolean;
      message: string;
    };
    if (input.sendSms === false) {
      sms = {
        status: "skipped",
        sent: false,
        message: "Rutten är publicerad till föraren. SMS valdes bort.",
      };
    } else if (!driver.phone?.trim()) {
      sms = {
        status: "missing_phone",
        sent: false,
        message: `${driver.name} saknar telefonnummer. Rutten publicerades men inget SMS skickades.`,
      };
    } else if (!isSmsConfigured()) {
      sms = {
        status: "not_configured",
        sent: false,
        message: "Ingen SMS-leverantör är konfigurerad. Rutten publicerades men inget SMS skickades.",
      };
    } else {
      const outcome = await resendRouteSms({
        routeId: route.id, organizationId: route.organizationId,
        expectedDriverId: driver.id, driverAppUrl,
      });
      const sent = "result" in outcome && outcome.result.sent;
      sms = sent
        ? {
            status: "sent",
            sent: true,
            message: `SMS skickades till ${driver.name}.`,
          }
        : {
            status: "failed",
            sent: false,
            message: "SMS-leverantören kunde inte skicka meddelandet. Försök igen.",
          };
    }

    res.json(
      DispatchRouteResponse.parse({
        ok: sms.sent || sms.status === "skipped",
        routeId: id,
        status: "in_progress",
        sms,
      }),
    );
  } catch (err) {
    if (err instanceof RoutePlanApprovalError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    handleError(res, err);
  }
});

router.post(
  "/routes/:id/resend-sms",
  requireRole("admin", "dispatcher"),
  resendSmsRateLimiter,
  async (req, res): Promise<void> => {
    let routeId: string;
    try {
      ({ id: routeId } = parseUuidParam(req.params));
    } catch (error) {
      await logRouteSmsResendEvent({
        req,
        routeId: null,
        statusCode: 400,
        code: "invalid_request",
        outcome: "rejected",
      });
      res.status(400).json({
        error: error instanceof Error ? error.message : "Ogiltig rutt.",
        code: "invalid_request",
      });
      return;
    }

    const parsed = ResendRouteSmsBody.safeParse(req.body);
    if (!parsed.success) {
      await logRouteSmsResendEvent({
        req,
        routeId,
        statusCode: 400,
        code: "invalid_request",
        outcome: "rejected",
      });
      res.status(400).json({
        error: "Ogiltig begäran. driverId måste vara ett giltigt chaufförs-id.",
        code: "invalid_request",
      });
      return;
    }

    try {
      const driverAppUrl = buildRouteDriverAppUrl({
        configuredUrl: process.env.DRIVER_APP_URL,
        requestOrigin: `${req.protocol}://${req.get("host")}`,
        routeId,
      });
      const outcome = await resendRouteSms({
        routeId,
        organizationId: getOrgId(req),
        expectedDriverId: parsed.data.driverId,
        driverAppUrl,
      });

      if ("error" in outcome) {
        await logRouteSmsResendEvent({
          req,
          routeId,
          statusCode: outcome.error.statusCode,
          code: outcome.error.code,
          outcome: "rejected",
        });
        res.status(outcome.error.statusCode).json({
          error: outcome.error.message,
          code: outcome.error.code,
        });
        return;
      }

      await logRouteSmsResendEvent({
        req,
        routeId,
        statusCode: 200,
        code: outcome.result.code,
        outcome: outcome.result.status,
      });
      res.json(ResendRouteSmsResponse.parse(outcome.result));
    } catch (err) {
      await logRouteSmsResendEvent({
        req,
        routeId,
        statusCode: 500,
        code: "internal_error",
        outcome: "failed",
      });
      res.status(500).json({
        error: "SMS kunde inte skickas.",
        code: "internal_error",
      });
    }
  },
);

router.get("/routes/:id/acknowledgement", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    let route;

    if (req.user?.role === "driver") {
      route = await driverOwnedRoute(req, id);
      if (!route) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
    } else if (req.user?.role === "admin" || req.user?.role === "dispatcher") {
      route = await routeService.getRoute(id, orgId);
      if (!route) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
    } else {
      res.status(403).json({ error: "Forbidden: insufficient role" });
      return;
    }

    // This is a compatibility display projection only. The versioned route
    // handoff fields are the sole source of acknowledgement state.
    if (!route.handoffDriverId || !route.sentAt || route.handoffStatus === "pending") {
      res.json(null);
      return;
    }
    const status = route.handoffStatus === "received"
      ? "delivered_to_app"
      : route.handoffStatus;
    const updatedAt = route.rejectedAt ?? route.acceptedAt ?? route.openedAt ??
      route.receivedAt ?? route.sentAt ?? route.updatedAt;
    res.json(GetRouteAcknowledgementResponse.parse({
      routeId: route.id,
      driverId: route.handoffDriverId,
      organizationId: route.organizationId,
      status,
      sentAt: route.sentAt,
      deliveredToAppAt: route.receivedAt,
      openedAt: route.openedAt,
      acceptedAt: route.acceptedAt,
      rejectedAt: route.rejectedAt,
      rejectionReason: route.rejectionReason,
      updatedAt,
    }));
  } catch (err) {
    handleError(res, err);
  }
});

router.post(
  "/routes/:id/execution-redistribution/approve",
  requireRole("admin", "dispatcher"),
  async (req, res) => {
    try {
      const { id } = parseUuidParam(req.params);
      const organizationId = getOrgId(req);
      const planVersion = z.object({ planVersion: z.number().int().nonnegative() }).parse(req.body).planVersion;
      const [route] = await db.select().from(routesTable).where(and(
        eq(routesTable.id, id),
        eq(routesTable.organizationId, organizationId),
      )).limit(1);
      if (!route) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
      if (route.planRevision !== planVersion) {
        res.status(409).json({ error: `Stale plan version; current version is ${route.planRevision}` });
        return;
      }
      if (route.redistributionSuggestion?.status !== "pending_approval") {
        res.status(409).json({ error: "No redistribution suggestion is awaiting approval" });
        return;
      }
      const approved = {
        ...route.redistributionSuggestion,
        status: "approved" as const,
        approvedAt: new Date().toISOString(),
        approvedBy: req.user!.id,
      };
      const [updated] = await db.update(routesTable).set({
        redistributionSuggestion: approved,
        updatedAt: new Date(),
      }).where(and(
        eq(routesTable.id, id),
        eq(routesTable.organizationId, organizationId),
        eq(routesTable.planRevision, planVersion),
      )).returning();
      await broadcastTenantEvent(organizationId, "execution:redistribution-approved", {
        routeId: id,
        planVersion,
        suggestion: approved,
      });
      res.json(updated);
    } catch (error) {
      handleError(res, error);
    }
  },
);

export default router;
