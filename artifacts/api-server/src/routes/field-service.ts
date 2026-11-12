/**
 * Field-service routes: driver certifications, service reports, billing-ready export.
 *
 * Auth notes
 * ----------
 * PUT /stops/:id/service-report is in DRIVER_WRITE_ALLOW.  When the caller is a
 * driver the route enforces a per-stop ownership chain:
 *   req.user.driverProfileId present
 *   body.driverId === req.user.driverProfileId          (own report only)
 *   stop.organizationId === req.user.organizationId      (org isolation)
 *   stop.route.vehicleId === driver.vehicleId            (assigned vehicle)
 *
 * Dispatcher and admin callers bypass the ownership check; the service layer
 * still validates that the referenced driver belongs to the org and the stop
 * is jobType=field_service.
 */
import { Router, type IRouter } from "express";
import { handleError, parseUuidParam } from "../lib/errors";
import { assertOrgScope, getOrgId } from "../middleware/auth";
import {
  requireBillingReadyReadAccess,
  requireServiceReportReadAccess,
} from "../middleware/field-service-read-access";
import { db, driversTable, stopsTable } from "@workspace/db";
import { eq, and } from "drizzle-orm";
import { z } from "zod";
import { outgoingStopContext } from "../services/outgoing-route-service";
import {
  CreateDriverCertificationBody,
  ListDriverCertificationsQueryParams,
  DeleteDriverCertificationQueryParams,
  GetServiceReportQueryParams,
  UpsertServiceReportBody,
  UpsertServiceReportResponse,
  GetServiceReportResponse,
  ListBillingReadyReportsResponse,
} from "@workspace/api-zod";

// Generated ListBillingReadyReportsQueryParams uses zod.date() which does not
// coerce query-string ISO strings. This local schema uses coerce so HTTP query
// params are accepted without pre-transformation.
const BillingReadyQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
});
import * as fieldService from "../services/field-service";
import {
  DriverAssistanceError,
  getDriverAssistanceContext,
} from "../lib/driver-assistance";
import { broadcastDataChange } from "../services/realtime";

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const router: IRouter = Router();

// ── Driver certifications ─────────────────────────────────────────────────────

router.get("/drivers/:id/certifications", async (req, res): Promise<void> => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    // Accept orgId from query (generated schema) but also fall back to auth context
    const qp = ListDriverCertificationsQueryParams.safeParse(req.query);
    const resolvedOrgId = qp.success ? (req.user?.organizationId ?? qp.data.organizationId) : orgId;

    const [driver] = await db
      .select({ id: driversTable.id })
      .from(driversTable)
      .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, resolvedOrgId)))
      .limit(1);
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    const certs = await fieldService.listDriverCertifications(id, resolvedOrgId);
    res.json(certs);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/drivers/:id/certifications", async (req, res): Promise<void> => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);

    const parsed = CreateDriverCertificationBody.safeParse({
      ...req.body,
      organizationId: req.body.organizationId ?? orgId,
    });
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", details: parsed.error.issues });
      return;
    }
    assertOrgScope(req, parsed.data.organizationId);

    const [driver] = await db
      .select({ id: driversTable.id })
      .from(driversTable)
      .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, orgId)))
      .limit(1);
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }

    const cert = await fieldService.createDriverCertification(id, orgId, {
      certificationCode: parsed.data.certificationCode,
      certificationName: parsed.data.certificationName,
      issuedAt: parsed.data.issuedAt,
      expiresAt: parsed.data.expiresAt ?? null,
    });
    broadcastDataChange(orgId, "certification", "created", {
      id: cert.id,
      driverId: id,
    });
    res.status(201).json(cert);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/drivers/:id/certifications/:certId", async (req, res): Promise<void> => {
  try {
    const { id } = parseUuidParam(req.params);
    const rawCertId = Array.isArray(req.params.certId) ? req.params.certId[0] : req.params.certId;
    if (!rawCertId || !UUID_REGEX.test(rawCertId)) {
      res.status(400).json({ error: "Invalid certId parameter" });
      return;
    }

    const orgId = getOrgId(req);
    // Validate query params (generated schema)
    const qp = DeleteDriverCertificationQueryParams.safeParse(req.query);
    const resolvedOrgId = qp.success ? assertOrgScope(req, qp.data.organizationId) : orgId;

    const [driver] = await db
      .select({ id: driversTable.id })
      .from(driversTable)
      .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, resolvedOrgId)))
      .limit(1);
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }

    const deleted = await fieldService.deleteDriverCertification(rawCertId, resolvedOrgId);
    if (!deleted) {
      res.status(404).json({ error: "Certification not found" });
      return;
    }
    broadcastDataChange(orgId, "certification", "deleted", {
      id: deleted.id,
      driverId: id,
    });
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

// ── Service reports ───────────────────────────────────────────────────────────

router.get(
  "/stops/:id/service-report",
  requireServiceReportReadAccess(),
  async (req, res): Promise<void> => {
    try {
      const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { id } = parseUuidParam({ id: rawId ?? "" });

      // Validate query params via generated schema
      const qp = GetServiceReportQueryParams.safeParse(req.query);
      const orgId = qp.success ? assertOrgScope(req, qp.data.organizationId) : getOrgId(req);

      const result = await fieldService.getServiceReportByStop(id, orgId);
      if (!result) {
        res.status(404).json({ error: "Service report not found" });
        return;
      }

      // Validate response shape via generated schema
      const validated = GetServiceReportResponse.safeParse(result);
      if (validated.success) {
        res.json(validated.data);
      } else {
        res.json(result);
      }
    } catch (err) {
      handleError(res, err);
    }
  },
);

router.put("/stops/:id/service-report", async (req, res): Promise<void> => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const assistance = getDriverAssistanceContext(req);
    let executionRouteId: string | null = null;
    let outgoingPlanVersion: number | undefined;

    // Validate request body via generated schema
    const parsed = UpsertServiceReportBody.safeParse({
      ...req.body,
      organizationId: req.body.organizationId ?? orgId,
    });
    if (!parsed.success) {
      res.status(400).json({ error: "Validation error", details: parsed.error.issues });
      return;
    }
    assertOrgScope(req, parsed.data.organizationId);

    // Hard business rule: billing_ready requires completedAt
    if (parsed.data.status === "billing_ready" && !parsed.data.completedAt) {
      res.status(400).json({ error: "billing_ready status requires completedAt" });
      return;
    }

    // ── Driver ownership check ──────────────────────────────────────────────
    // When the caller is a driver the service-report must be their own:
    //   1. req.user.driverProfileId must be present.
    //   2. body.driverId must equal that profile id (own report only).
    //   3. The stop's route must be assigned to the driver's vehicle.
    // Admin and dispatcher callers skip this check.
    if (req.user?.role === "driver" || assistance) {
      const driverProfileId = assistance?.driverId ?? req.user!.driverProfileId;
      if (!driverProfileId) {
        res.status(403).json({ error: "Forbidden: driver account has no linked driver profile" });
        return;
      }
      if (parsed.data.driverId !== driverProfileId) {
        res.status(403).json({ error: "Forbidden: service reports must use the selected driver's identity" });
        return;
      }
      const ownershipErr = await fieldService.verifyDriverStopOwnership(id, orgId, driverProfileId);
      if (ownershipErr) {
        res.status(ownershipErr.statusCode).json({ error: ownershipErr.message });
        return;
      }
      // Ownership proves the current assignment; the selected route header
      // makes a stale assistance scope fail rather than becoming an admin
      // write to another route.
      const context = await outgoingStopContext(orgId, id, driverProfileId, db, assistance?.routeId);
      executionRouteId = context.route.id; outgoingPlanVersion = context.route.planRevision;
      if (req.body.planVersion !== undefined && req.body.planVersion !== outgoingPlanVersion) {
        res.status(409).json({ error: "Utskicksplatsens version har ändrats. Läs in och granska aktuell version." }); return;
      }
    }

    const result = await fieldService.upsertServiceReport(id, orgId, {
      driverId: parsed.data.driverId,
      status: parsed.data.status,
      startedAt: parsed.data.startedAt ?? null,
      completedAt: parsed.data.completedAt ?? null,
      actualDurationMin: parsed.data.actualDurationMin ?? null,
      notes: parsed.data.notes ?? null,
      customerSignatoryName: parsed.data.customerSignatoryName ?? null,
      signatureEvidenceRef: parsed.data.signatureEvidenceRef ?? null,
      materials: parsed.data.materials,
      assistedRouteId: assistance?.routeId ?? null,
      executionRouteId, outgoingPlanVersion,
    });
    if (!result) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }

    // Validate response shape via generated schema
    const validated = UpsertServiceReportResponse.safeParse(result);
    if (validated.success) {
      res.json(validated.data);
    } else {
      res.json(result);
    }
  } catch (err) {
    if (err instanceof fieldService.ServiceReportValidationError || err instanceof DriverAssistanceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

// ── Billing-ready export ──────────────────────────────────────────────────────

router.get(
  "/organizations/:id/billing-ready",
  requireBillingReadyReadAccess(),
  async (req, res): Promise<void> => {
    try {
      const rawId = Array.isArray(req.params.id) ? req.params.id[0] : req.params.id;
      const { id } = parseUuidParam({ id: rawId ?? "" });
      const orgId = getOrgId(req);
      if (id !== orgId) {
        res.status(403).json({ error: "Access denied: organization mismatch" });
        return;
      }

      // Use coercing local schema for date query params (generated schema uses zod.date()
      // which does not coerce ISO strings from query strings).
      const qp = BillingReadyQuerySchema.safeParse(req.query);
      if (!qp.success) {
        res.status(400).json({ error: "Validation error", details: qp.error.issues });
        return;
      }

      const reports = await fieldService.listBillingReadyReports(orgId, qp.data.from, qp.data.to);

      // Validate response via generated schema
      const validated = ListBillingReadyReportsResponse.safeParse(reports);
      if (validated.success) {
        res.json(validated.data);
      } else {
        res.json(reports);
      }
    } catch (err) {
      handleError(res, err);
    }
  },
);

export default router;
