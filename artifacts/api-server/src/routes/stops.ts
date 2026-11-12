import { Router, type IRouter } from "express";
import {
  CreateStopBody,
  UpdateStopBody,
  ListStopsQueryParams,
  ListOrganizationStopsQueryParams,
  ListOrganizationStopsResponse,
  ImportStopsBody,
  BulkDeleteStopsBody,
  BulkArchiveStopsBody,
  BulkArchiveStopsResponse,
  AssignStopToRouteBody,
  AssignStopToRouteParams,
  AssignStopToRouteResponse,
  MoveDispatchStopsBody,
  MoveDispatchStopsResponse,
  PreviewDispatchStopMoveBody,
  PreviewDispatchStopMoveResponse,
  DeferDispatchStopsBody,
  DeferDispatchStopsResponse,
} from "@workspace/api-zod";
import { handleError, parseUuidParam } from "../lib/errors";
import { assertOrgScope, getOrgId, requireRole } from "../middleware/auth";
import { requireStopReadAccess } from "../middleware/field-service-read-access";
import * as stopService from "../services/stop-service";
import { DispatchTargetOptimizationError } from "../services/dispatch-target-optimizer";
import { geocodeAddress, getCachedVerifiedGeocode } from "../services/geocoding";
import { withStopProofTypes } from "../services/stop-proof-summary";
import {
  applyVerifiedNavigationDestination,
  cleanNavigationVerification,
  NAVIGATION_ADDRESS_KEY,
  NAVIGATION_VERIFIED_KEY,
} from "../services/stop-service";
import { z } from "zod";
import { payloadIdentityHash } from "../services/planning-draft-service";
import {
  ExecutionEventError,
  recordExecutionEvent,
  STANDARD_SKIP_REASONS,
} from "../services/execution-event-service";
import {
  DriverAssistanceError,
  executionActorForRequest,
  getDriverAssistanceContext,
} from "../lib/driver-assistance";

const router: IRouter = Router();
export const requireBulkStopDeleteAccess = requireRole("admin", "dispatcher");
const DispatchMoveBody = MoveDispatchStopsBody.refine(
  (data) => Number.isInteger(data.targetIndex),
  { path: ["targetIndex"], message: "targetIndex must be an integer" },
);

function needsGeocode(obj: Record<string, unknown>): boolean {
  if (!obj || typeof obj.address !== "string" || !obj.address.trim()) return false;
  const lat = obj.latitude;
  const lon = obj.longitude;
  const missing = (v: unknown) => v == null || v === "" || (typeof v === "number" && Number.isNaN(v));
  return missing(lat) || missing(lon);
}

async function autoGeocode(
  obj: Record<string, unknown>,
  options: { preserveCoordinates?: boolean } = {},
): Promise<{ geocoded: boolean; failed?: string }> {
  cleanNavigationVerification(obj);
  if (!obj || typeof obj.address !== "string" || !obj.address.trim()) return { geocoded: false };
  // Import coordinates already represent an explicit candidate choice or
  // supplied source coordinates. Re-resolving the preserved original text
  // can select a different destination. They are still range-validated before
  // persistence. Only matching, already cached provider evidence can mark
  // them verified; never perform another provider lookup or move the point.
  if (options.preserveCoordinates && !needsGeocode(obj)) {
    const verified = await getCachedVerifiedGeocode(obj.address as string);
    stopService.verifyPreservedNavigationDestination(obj, verified);
    return { geocoded: false };
  }
  const result = await geocodeAddress(obj.address as string);
  if (!result) {
    return needsGeocode(obj)
      ? { geocoded: false, failed: obj.address as string }
      : { geocoded: false };
  }
  applyVerifiedNavigationDestination(obj, result);
  return { geocoded: true };
}

function needsPickupGeocode(obj: Record<string, unknown>): boolean {
  if (!obj || typeof obj.pickupAddress !== "string" || !obj.pickupAddress.trim()) return false;
  const lat = obj.pickupLatitude;
  const lon = obj.pickupLongitude;
  const missing = (v: unknown) => v == null || v === "" || (typeof v === "number" && Number.isNaN(v));
  return missing(lat) || missing(lon);
}

async function autoGeocodePickup(obj: Record<string, unknown>): Promise<{ geocoded: boolean; failed?: string }> {
  if (!needsPickupGeocode(obj)) return { geocoded: false };
  const result = await geocodeAddress(obj.pickupAddress as string);
  if (!result) return { geocoded: false, failed: obj.pickupAddress as string };
  obj.pickupLatitude = result.latitude;
  obj.pickupLongitude = result.longitude;
  return { geocoded: true };
}

router.get("/stops", async (req, res) => {
  try {
    const { organizationId, routeId } = ListStopsQueryParams.parse(req.query);
    const orgId = assertOrgScope(req, organizationId);
    const stops = await stopService.listStops(orgId, routeId, req.user);
    res.json(await withStopProofTypes(stops, orgId, req.user?.role));
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/stops/organization", requireBulkStopDeleteAccess, async (req, res): Promise<void> => {
  try {
    const rawQuery: Record<string, unknown> = { ...req.query };
    for (const key of ["dateFrom", "dateToExclusive"] as const) {
      if (typeof rawQuery[key] === "string") rawQuery[key] = new Date(rawQuery[key]);
    }
    if (typeof rawQuery.includeWithoutPlannedDate === "string") {
      if (rawQuery.includeWithoutPlannedDate === "true") rawQuery.includeWithoutPlannedDate = true;
      else if (rawQuery.includeWithoutPlannedDate === "false") rawQuery.includeWithoutPlannedDate = false;
      else {
        res.status(400).json({ error: "includeWithoutPlannedDate must be true or false" });
        return;
      }
    }
    const query = ListOrganizationStopsQueryParams.parse(rawQuery);
    const orgId = assertOrgScope(req, query.organizationId);
    const page = await stopService.listOrganizationStops(orgId, query);
    res.json(ListOrganizationStopsResponse.parse(page));
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/stops/import", async (req, res) => {
  try {
    const data = ImportStopsBody.parse(req.body);
    const orgId = assertOrgScope(req, data.organizationId);
    const draftId = data.draftId ?? undefined;
    stopService.assertImportRowCount(data.expectedRowCount, data.stops.length);
    const rawStops = Array.isArray(req.body?.stops) ? req.body.stops : [];
    const stops = data.stops.map((stop, index) => {
      const raw = rawStops[index];
      const enriched: Record<string, unknown> = { ...stop };
      if (raw && Object.prototype.hasOwnProperty.call(raw, "customerId")) {
        enriched.customerId = raw.customerId;
      }
      if (raw && Object.prototype.hasOwnProperty.call(raw, "planningDate")) {
        enriched.planningDate = z.coerce.date().parse(raw.planningDate);
      }
      return enriched;
    });
    const clientPayloadHash = payloadIdentityHash({
      expectedRowCount: data.expectedRowCount,
      stops,
    });
    if (draftId) {
      const replay = await stopService.getDraftImportReplay(
        orgId,
        draftId,
        clientPayloadHash,
      );
      if (replay) {
        res.status(200).json(replay.result);
        return;
      }
    }
    const failedAddresses: string[] = [];
    const failedPickupAddresses: string[] = [];
    const rowResults: Array<{
      sourceRowNumber: number;
      status: "rejected";
      reasons: string[];
    }> = [];
    if (Array.isArray(stops)) {
      for (let index = 0; index < stops.length; index += 1) {
        const s = stops[index] as Record<string, unknown>;
        const reasons: string[] = [];
        const r = await autoGeocode(s, { preserveCoordinates: true });
        if (r.failed) {
          failedAddresses.push(r.failed);
          reasons.push(`Leveransadressen "${r.failed}" kunde inte geokodas.`);
        }
        const rp = await autoGeocodePickup(s);
        if (rp.failed) {
          failedPickupAddresses.push(rp.failed as string);
          reasons.push(`Pickupadressen "${rp.failed}" kunde inte geokodas.`);
        }
        reasons.push(...stopService.validateImportStopCoordinates(s));
        if (reasons.length > 0) {
          rowResults.push({
            sourceRowNumber: data.stops[index]?.sourceRowNumber ?? index + 1,
            status: "rejected",
            reasons,
          });
        }
      }
    }
    if (rowResults.length > 0) {
      res.status(422).json({
        error: "One or more rows are invalid. No rows were saved.",
        failedAddresses,
        failedPickupAddresses,
        rowResults,
      });
      return;
    }
    if (draftId) {
      const imported = await stopService.importStopsForDraft(
        orgId,
        draftId,
        stops,
        data.expectedRowCount,
        clientPayloadHash,
      );
      res.status(imported.replayed ? 200 : 201).json(imported.result);
      return;
    }
    const created = await stopService.importStops(orgId, stops, data.expectedRowCount);
    res.status(201).json({
      imported: created.length,
      receivedRowCount: stops.length,
      savedRowCount: created.length,
      stops: created,
      rowResults: created.map((stop, index) => ({
        sourceRowNumber: data.stops[index]?.sourceRowNumber ?? index + 1,
        status: "saved",
        stopId: stop.id,
      })),
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/stops/bulk-delete", requireBulkStopDeleteAccess, async (req, res) => {
  try {
    const data = BulkDeleteStopsBody.parse(req.body);
    // This destructive operation must never use tenant scope supplied in a
    // query string or request body. The guard above guarantees req.user.
    const orgId = req.user!.organizationId;
    const deleted = await stopService.deleteStops(data.stopIds, orgId);
    res.json({ deletedCount: deleted.length });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/stops/bulk-archive", requireBulkStopDeleteAccess, async (req, res) => {
  try {
    const data = BulkArchiveStopsBody.parse(req.body);
    const result = await stopService.archiveStops(
      data.stopIds,
      req.user!.organizationId,
      { userId: req.user!.id, userEmail: req.user!.email ?? null },
      data.confirmActiveRoutes ?? false,
    );
    res.json(BulkArchiveStopsResponse.parse(result));
  } catch (err) {
    if (err instanceof stopService.StopBulkArchiveConfirmationRequiredError) {
      res.status(err.statusCode).json({
        error: err.message,
        code: err.code,
        details: { affectedRouteIds: err.affectedRouteIds },
      });
      return;
    }
    handleError(res, err);
  }
});

router.post("/stops/:id/dispatch-assignment", requireRole("admin", "dispatcher"), async (req, res): Promise<void> => {
  try {
    const params = AssignStopToRouteParams.parse(req.params);
    const data = AssignStopToRouteBody.parse(req.body);
    // This is an explicitly dispatcher-only action. Tenant scope always comes
    // from the authenticated session; the audit middleware records force=true.
    const result = await stopService.assignStopForDispatch(
      params.id,
      req.user!.organizationId,
      data,
    );
    if (result.kind === "not_found") {
      res.status(404).json({ error: "Stop or route not found" });
      return;
    }
    if (result.kind === "ineligible") {
      res.status(409).json({
        error: result.error,
        conflicts: [],
        ...(result.code ? { code: result.code, details: result.details } : {}),
      });
      return;
    }
    if (result.kind === "conflict") {
      res.status(409).json({
        error: "The stop does not fit this route without an override",
        conflicts: result.conflicts,
      });
      return;
    }
    res.json(AssignStopToRouteResponse.parse(result.stop));
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/stops/dispatch-move", requireRole("admin", "dispatcher"), async (req, res): Promise<void> => {
  try {
    const data = DispatchMoveBody.parse(req.body);
    const result = await stopService.moveStopsForDispatch(
      req.user!.organizationId,
      data,
    );
    if (result.kind === "not_found") {
      res.status(404).json({ error: "One or more stops or the target route were not found" });
      return;
    }
    if (result.kind === "ineligible") {
      res.status(409).json({
        error: result.error,
        conflicts: [],
        ...(result.code ? { code: result.code, details: result.details } : {}),
      });
      return;
    }
    if (result.kind === "conflict") {
      res.status(409).json({
        error: "The selected stops do not fit the prospective routes without an override",
        conflicts: result.conflicts,
      });
      return;
    }
    if (result.kind !== "moved") {
      throw new Error("Dispatch move unexpectedly returned a preview result");
    }
    res.json(MoveDispatchStopsResponse.parse({
      stops: result.stops,
      conflicts: result.conflicts,
      draftId: result.draftId,
    }));
  } catch (err) {
    if (err instanceof DispatchTargetOptimizationError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof stopService.DispatchRevisionConflictError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    handleError(res, err);
  }
});

router.post("/stops/dispatch-move/preview", requireRole("admin", "dispatcher"), async (req, res): Promise<void> => {
  try {
    const data = PreviewDispatchStopMoveBody.parse(req.body);
    const result = await stopService.moveStopsForDispatch(
      req.user!.organizationId,
      data,
      { previewOnly: true },
    );
    if (result.kind === "not_found") {
      res.status(404).json({ error: "One or more stops or the target route were not found" });
      return;
    }
    if (result.kind === "ineligible") {
      res.status(409).json({
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
        ...(result.details ? { details: result.details } : {}),
      });
      return;
    }
    if (result.kind === "conflict") {
      res.status(409).json({
        error: "The prospective move has conflicts that cannot be overridden",
        conflicts: result.conflicts,
      });
      return;
    }
    if (result.kind !== "preview") {
      throw new Error("Dispatch move preview unexpectedly attempted a write");
    }
    res.json(PreviewDispatchStopMoveResponse.parse({
      canMove: result.canMove,
      conflicts: result.conflicts,
      sourceRouteIds: result.sourceRouteIds,
      targetRouteId: result.targetRouteId,
      targetStopCount: result.targetStopCount,
      previewDigest: result.previewDigest,
      consequences: result.consequences,
    }));
  } catch (err) {
    if (err instanceof DispatchTargetOptimizationError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    if (err instanceof stopService.DispatchRevisionConflictError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    handleError(res, err);
  }
});

router.post("/stops/dispatch-defer", requireRole("admin", "dispatcher"), async (req, res): Promise<void> => {
  try {
    const data = DeferDispatchStopsBody.parse(req.body);
    const result = await stopService.deferStopsForDispatch(
      req.user!.organizationId,
      data,
    );
    if (result.kind === "not_found") {
      res.status(404).json({ error: "One or more stops or source routes were not found" });
      return;
    }
    if (result.kind === "ineligible") {
      res.status(409).json({
        error: result.error,
        ...(result.code ? { code: result.code } : {}),
      });
      return;
    }
    res.json(DeferDispatchStopsResponse.parse(result));
  } catch (err) {
    if (err instanceof stopService.DispatchRevisionConflictError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    handleError(res, err);
  }
});

router.get("/stops/:id", requireStopReadAccess(), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const stop = await stopService.getStop(id, orgId, req.user);
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    res.json(stop);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/stops", async (req, res) => {
  try {
    if (req.body?.planningPlanId != null) {
      res.status(400).json({ error: "Använd planens formulär för att skapa ett planbundet stopp." });
      return;
    }
    const geo = await autoGeocode(req.body ?? {});
    if (geo.failed) {
      res.status(400).json({ error: `Could not geocode address: "${geo.failed}". Provide latitude and longitude explicitly.` });
      return;
    }
    const pickupGeo = await autoGeocodePickup(req.body ?? {});
    if (pickupGeo.failed) {
      res.status(400).json({ error: `Could not geocode pickup address: "${pickupGeo.failed}". Provide pickupLatitude and pickupLongitude explicitly.` });
      return;
    }
    const data = {
      ...CreateStopBody.parse(req.body),
      ...(Object.prototype.hasOwnProperty.call(req.body ?? {}, "planningDate")
        ? { planningDate: z.coerce.date().parse(req.body.planningDate) }
        : {}),
    };
    data.organizationId = assertOrgScope(req, data.organizationId);
    const contactFields: Record<string, string> = {};
    if (typeof req.body.contactName === "string") contactFields.contactName = req.body.contactName;
    if (typeof req.body.contactEmail === "string") contactFields.contactEmail = req.body.contactEmail;
    const stop = await stopService.createStop({ ...data, ...contactFields });
    res.status(201).json(stop);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/stops/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const assistance = getDriverAssistanceContext(req);
    if (
      req.user?.role === "driver"
      && (
        req.body?.status === "completed"
        || req.body?.status === "failed"
        || req.body?.status === "skipped"
      )
    ) {
      res.status(400).json({
        error: "Drivers must record terminal stops as execution events",
      });
      return;
    }
    const orgId = getOrgId(req);
    const existing = await stopService.getStop(id, orgId, req.user);
    if (!existing) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    const changesDestination = req.body && (
      typeof req.body.address === "string"
      || req.body.latitude != null
      || req.body.longitude != null
    );
    if (changesDestination) {
      const verificationInput: Record<string, unknown> = {
        address: req.body.address ?? existing.address,
        latitude: req.body.latitude ?? existing.latitude,
        longitude: req.body.longitude ?? existing.longitude,
        customFields: {
          ...(existing.customFields ?? {}),
          ...(req.body.customFields ?? {}),
        },
      };
      const geo = await autoGeocode(verificationInput);
      if (geo.failed) {
        res.status(400).json({ error: `Could not geocode address: "${geo.failed}". Provide latitude and longitude explicitly.` });
        return;
      }
      req.body.latitude = verificationInput.latitude;
      req.body.longitude = verificationInput.longitude;
      req.body.customFields = verificationInput.customFields;
    } else if (req.body?.customFields) {
      const trustedVerification = {
        [NAVIGATION_VERIFIED_KEY]: existing.customFields?.[NAVIGATION_VERIFIED_KEY],
        [NAVIGATION_ADDRESS_KEY]: existing.customFields?.[NAVIGATION_ADDRESS_KEY],
      };
      cleanNavigationVerification(req.body);
      req.body.customFields = {
        ...(req.body.customFields ?? {}),
        ...Object.fromEntries(
          Object.entries(trustedVerification).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
        ),
      };
    }
    // Use needsPickupGeocode to catch partial-coordinate updates (not just both-null).
    if (needsPickupGeocode(req.body ?? {})) {
      const pickupGeo = await autoGeocodePickup(req.body ?? {});
      if (pickupGeo.failed) {
        res.status(400).json({ error: `Could not geocode pickup address: "${pickupGeo.failed}". Provide pickupLatitude and pickupLongitude explicitly.` });
        return;
      }
    }
    const data = {
      ...UpdateStopBody.parse(req.body),
      ...(Object.prototype.hasOwnProperty.call(req.body ?? {}, "planningDate")
        ? { planningDate: z.coerce.date().parse(req.body.planningDate) }
        : {}),
    };
    const contactFields: Record<string, string | null> = {};
    if (typeof req.body.contactName === "string" || req.body.contactName === null) contactFields.contactName = req.body.contactName;
    if (typeof req.body.contactEmail === "string" || req.body.contactEmail === null) contactFields.contactEmail = req.body.contactEmail;
    const stop = await stopService.updateStop(
      id,
      orgId,
      data,
      contactFields,
      assistance?.driverId ?? (req.user?.role === "driver" ? req.user.driverProfileId : null),
      assistance?.routeId ?? null,
      { expectedOutgoingVersion: req.body?.planVersion === undefined ? undefined : z.number().int().min(0).parse(req.body.planVersion) },
    );
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    res.json(stop);
  } catch (err) {
    handleError(res, err);
  }
});

const ExecutionEventBody = z.object({
  clientEventId: z.string().min(1).max(200),
  type: z.enum(["completed", "failed", "skipped", "comment", "actual_time", "select_next"]),
  expectedSelectionRevision: z.string().max(128).optional(),
  planVersion: z.number().int().nonnegative(),
  occurredAt: z.string().datetime(),
  skipReason: z.enum(STANDARD_SKIP_REASONS).optional(),
  comment: z.string().max(2000).optional(),
  actualDurationMin: z.number().int().nonnegative().max(24 * 60).optional(),
});

router.post(
  "/stops/:id/execution-events",
  requireRole("admin", "dispatcher", "driver"),
  async (req, res) => {
    try {
      const { id } = parseUuidParam(req.params);
      const actor = executionActorForRequest(req, getDriverAssistanceContext(req));
      const result = await recordExecutionEvent({
        ...actor,
        stopId: id,
        input: ExecutionEventBody.parse(req.body),
      });
      res.status(result.duplicate ? 200 : 201).json(result);
    } catch (error) {
      if (error instanceof ExecutionEventError || error instanceof DriverAssistanceError) {
        res.status(error.statusCode).json({ error: error.message,
          ...(req.body?.type === "select_next" ? { code: "STOP_SELECTION_BLOCKED" } : {}) });
        return;
      }
      handleError(res, error);
    }
  },
);

router.delete("/stops/:id", requireBulkStopDeleteAccess, async (req, res): Promise<void> => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const deleted = await stopService.deleteStop(id, orgId);
    if (!deleted) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
