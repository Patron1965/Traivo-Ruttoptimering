import type { RequestHandler } from "express";
import { preparePersistedRouteRoadData, roadCoordinate } from "../services/operational-road-preparation";
import { handleError } from "../lib/errors";

export const prepareOperationalRoadData: RequestHandler = async (req, res, next) => {
  const orgId = req.user?.organizationId;
  // Execution/receipt/POD operate on the outgoing snapshot. A saved working
  // proposal must not trigger routing preparation or block an actual fact.
  const executionPath = /^\/routes\/[^/]+\/(?:execution(?:\/(?:start|end))?|start|end|handoff|messages|incidents|planning-locks|locked-first-stop)(?:\/|$)/.test(req.path)
    || /^\/stops\/[^/]+\/(?:execution-events|proof|service-report|messages|exceptions)(?:\/|$)/.test(req.path);
  const metadataOnlyRoute = req.method === "PUT" && /^\/routes\/[^/]+\/?$/.test(req.path)
    && Object.keys(req.body ?? {}).every((key) => ["name", "status", "planRevision", "notifyApproaching", "notifyDelivered"].includes(key));
  const executionOnlyStop = req.method === "PUT" && /^\/stops\/[^/]+\/?$/.test(req.path)
    && Object.keys(req.body ?? {}).every((key) => ["status", "skipReason", "skipComment", "actualDurationMin", "executionComment", "clientEventId", "planVersion", "occurredAt"].includes(key));
  if (!orgId || !["admin", "dispatcher"].includes(req.user!.role) ||
      executionPath || metadataOnlyRoute || executionOnlyStop ||
      !/^\/(?:import\/route-plans|routes\/|stops\/)/.test(req.path) ||
      req.method === "DELETE" || /customer-link|resend-notification/.test(req.path) ||
      // Cleanup preserves/cancels history; it never calculates a new itinerary.
      /^\/(?:routes\/bulk-delete|stops\/bulk-(?:delete|archive))\/?$/.test(req.path) ||
      // Creation owns matrix preparation AFTER registering durable progress.
      // A failure before registration leaves clients polling a nonexistent job.
      (req.method === "POST" && /^\/import\/route-plans\/?$/.test(req.path)) ||
      (req.method === "GET" && !/preflight|preview/.test(req.path))) {
    next(); return;
  }
  try {
    const body: Record<string, unknown> = req.body ?? {};
    const strings = (value: unknown): string[] => Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : typeof value === "string" ? [value] : [];
    const rows: Record<string, unknown>[] = Array.isArray(body.routes)
      ? body.routes.filter((row: unknown): row is Record<string, unknown> => row !== null && typeof row === "object") : [];
    await preparePersistedRouteRoadData(orgId, {
      routeIds: [
        ...strings(/^\/routes\/([^/]+)/.exec(req.path)?.[1]), ...strings(body.routeIds),
        ...strings(body.routeId), ...strings(body.targetRouteId), ...strings(body.sourceRouteId),
        ...rows.flatMap(row => strings(row.routeId ?? row.id)),
      ],
      planIds: [...strings(/^\/import\/route-plans\/([^/]+)/.exec(req.path)?.[1]), ...strings(body.planId)],
      stopIds: [...strings(/^\/stops\/([^/]+)/.exec(req.path)?.[1]), ...strings(body.stopIds), ...rows.flatMap(row => strings(row.stopIds))],
      driverIds: [...strings(body.driverId), ...rows.flatMap(row => strings(row.driverId))],
      vehicleIds: [...strings(body.vehicleId), ...rows.flatMap(row => strings(row.vehicleId))],
      coordinates: [...roadCoordinate(body.latitude, body.longitude), ...roadCoordinate(body.depotLatitude, body.depotLongitude)],
    });
    next();
  } catch (error) { handleError(res, error); }
};
