import { Router, type IRouter } from "express";
import { and, desc, eq } from "drizzle-orm";
import { RecoverCustomerNotificationBody, RecoverCustomerNotificationParams } from "@workspace/api-zod";
import { z } from "zod";
import { db, organizationsTable, routesTable, customerNotificationAttemptsTable } from "@workspace/db";
import { handleError } from "../lib/errors";
import { requireRole } from "../middleware/auth";
import { logAdminEvent } from "../lib/security-log";
import { geocodeDetailed } from "../services/geocoding";
import {
  MAX_PLANNING_ALLOWANCE_MIN,
  normalizePlanningAllowance,
} from "../services/planning-policy";
import { broadcastDataChange } from "../services/realtime";
import { updateReportCategories } from "../services/report-categories";
import { customerNotificationConfigSchema } from "../services/customer-notification-config";
import { recoverCustomerNotification } from "../services/customer-notifications";
import { normalizePhone } from "../services/sms";

const router: IRouter = Router();

router.get("/org/report-categories", requireRole("admin", "dispatcher", "driver", "viewer"), async (req, res) => {
  try {
    const [org] = await db.select({ config: organizationsTable.reportCategories }).from(organizationsTable)
      .where(eq(organizationsTable.id, req.user!.organizationId));
    if (!org) { res.status(404).json({ error: "Företaget finns inte." }); return; }
    res.json(org.config);
  } catch (error) { handleError(res, error); }
});

router.put("/org/report-categories", requireRole("admin"), async (req, res) => {
  try {
    const config = await updateReportCategories(req.user!.organizationId, req.body);
    await logAdminEvent({ req, action: "report_categories.updated", resourceType: "organization",
      resourceId: req.user!.organizationId, statusCode: 200, diff: { revision: config.revision, categories: config.categories } });
    res.json(config);
  } catch (error) { handleError(res, error); }
});

router.post("/organizations/:id/customer-notifications/:attemptId/recover", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const params = RecoverCustomerNotificationParams.safeParse(req.params);
    const body = RecoverCustomerNotificationBody.safeParse(req.body);
    if (!params.success || !body.success) { res.status(400).json({ error: "Ogiltig begäran." }); return; }
    const orgId = req.user!.organizationId;
    if (params.data.id !== orgId) { res.status(404).json({ error: "Organisationen hittades inte." }); return; }
    const [attempt] = await db.select().from(customerNotificationAttemptsTable).where(and(
      eq(customerNotificationAttemptsTable.id, params.data.attemptId),
      eq(customerNotificationAttemptsTable.organizationId, orgId),
    ));
    if (!attempt) { res.status(404).json({ error: "Utskicksförsöket hittades inte." }); return; }
    const recipient = body.data.recipient.trim();
    const valid = attempt.channel === "sms" ? /^\+[1-9]\d{7,14}$/.test(normalizePhone(recipient))
      : attempt.channel === "email" && z.string().email().safeParse(recipient).success;
    if (!valid) { res.status(400).json({ error: "Ange ett giltigt telefonnummer eller en giltig e-postadress för vald kanal." }); return; }
    const processed = await recoverCustomerNotification(orgId, {
      id: attempt.id, revision: body.data.revision, recipient, actorId: req.user!.id,
    });
    if (!processed) {
      res.status(409).json({ error: "Utskicket kan inte återhanteras. Det kan ha ändrats, vara osäkert eller inte längre vara aktuellt. Kontrollera också att händelsen och kanalen är aktiverade." });
      return;
    }
    await logAdminEvent({ req, action: "customer_notification.recovered", resourceType: "organization", resourceId: orgId, statusCode: 200, diff: { attemptId: attempt.id } });
    res.json({ processed: true });
  } catch (err) { handleError(res, err); }
});

const OPERATING_MODE_VALUES = ["transport", "field_service", "mixed"] as const;
const OperatingModeSchema = z.enum(OPERATING_MODE_VALUES);

const SETTINGS_SCALAR_FIELDS = [
  "autoBalance", "snapToRoad", "defaultRouteType",
  "maxDriverOvertimeMin", "allowLateStopsMin", "defaultServiceDurationMin",
  "customerSupportType",
  "notifyOrderCreated", "notifyDriverEnRoute", "notifyDelivered", "notifyFailed",
  "notificationSenderType", "notificationTemplate",
] as const;
const StopRetentionSettingsSchema = z.object({
  stopRetentionEnabled: z.boolean().optional(),
  stopRetentionDays: z.number().int().min(7).max(3650).optional(),
});
const DepotVerificationSchema = z.object({
  address: z.string().trim().min(5).max(500),
  postalCode: z.string().trim().max(30).optional(),
  city: z.string().trim().max(120).optional(),
  countryCode: z.string().trim().length(2).optional(),
});
const DEPOT_FIELDS = [
  "depotStartAddress", "depotStartLatitude", "depotStartLongitude", "depotStartVerification", "depotStartVerifiedAt",
  "depotEndAddress", "depotEndLatitude", "depotEndLongitude", "depotEndVerification", "depotEndVerifiedAt",
] as const;

router.get("/organizations/:id/settings", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const orgId = req.user!.organizationId;
    if (req.params.id !== orgId) { res.status(404).json({ error: "Organization not found" }); return; }
    const [org] = await db.select().from(organizationsTable).where(eq(organizationsTable.id, orgId));
    if (!org) { res.status(404).json({ error: "Organization not found" }); return; }
    res.json({
      autoBalance: org.autoBalance,
      snapToRoad: org.snapToRoad,
      defaultRouteType: org.defaultRouteType,
      operatingMode: org.operatingMode,
      maxDriverOvertimeMin: org.maxDriverOvertimeMin,
      allowLateStopsMin: org.allowLateStopsMin,
      defaultServiceDurationMin: org.defaultServiceDurationMin,
      customerSupportType: org.customerSupportType,
      notifyOrderCreated: org.notifyOrderCreated,
      notifyDriverEnRoute: org.notifyDriverEnRoute,
      notifyDelivered: org.notifyDelivered,
      notifyFailed: org.notifyFailed,
      notificationSenderType: org.notificationSenderType,
      notificationTemplate: org.notificationTemplate,
      customerNotifications: org.customerNotifications,
      notificationAttempts: await db.select().from(customerNotificationAttemptsTable)
        .where(eq(customerNotificationAttemptsTable.organizationId, orgId))
        .orderBy(desc(customerNotificationAttemptsTable.createdAt)).limit(20),
      stopRetentionEnabled: org.stopRetentionEnabled,
      stopRetentionDays: org.stopRetentionDays,
      ...Object.fromEntries(DEPOT_FIELDS.map((field) => [field, org[field]])),
    });
  } catch (err) { handleError(res, err); }
});

router.post("/organizations/:id/depot/:endpoint/verify", requireRole("admin"), async (req, res): Promise<void> => {
  try {
    const orgId = req.user!.organizationId;
    if (req.params.id !== orgId) { res.status(404).json({ error: "Organization not found" }); return; }
    const endpoint = z.enum(["start", "end"]).safeParse(req.params.endpoint);
    const input = DepotVerificationSchema.safeParse(req.body);
    if (!endpoint.success || !input.success) {
      res.status(400).json({ error: "A complete depot address and endpoint (start or end) are required.", details: !input.success ? input.error.issues : [{ message: "endpoint must be start or end" }] });
      return;
    }
    const geocoded = await geocodeDetailed({
      address: input.data.address, postalCode: input.data.postalCode, city: input.data.city,
    }, input.data.countryCode ?? "se");
    // geocodeDetailed only puts address-level, non-partial provider matches in result.
    // Candidates deliberately cannot be selected or supplied with caller coordinates.
    if (geocoded.status !== "matched" || !geocoded.result) {
      res.status(422).json({ error: "Depot address could not be provider-verified at address level.", code: "DEPOT_ADDRESS_NOT_VERIFIED", geocode: { status: geocoded.status, query: geocoded.query, candidates: geocoded.candidates } });
      return;
    }
    const result = geocoded.result, verifiedAt = new Date();
    const prefix = endpoint.data === "start" ? "depotStart" : "depotEnd";
    const updates: Record<string, unknown> = {
      [`${prefix}Address`]: result.displayName, [`${prefix}Latitude`]: result.latitude, [`${prefix}Longitude`]: result.longitude,
      [`${prefix}Verification`]: { provider: result.provider, source: result.source, displayName: result.displayName, query: geocoded.query },
      [`${prefix}VerifiedAt`]: verifiedAt,
    };
    const [org] = await db.update(organizationsTable).set(updates).where(eq(organizationsTable.id, orgId)).returning();
    await logAdminEvent({ req, action: "org.depot_verified", resourceType: "organization", resourceId: orgId, statusCode: 200, diff: { endpoint: endpoint.data, provider: result.provider } });
    res.json({ endpoint: endpoint.data, address: result.displayName, latitude: result.latitude, longitude: result.longitude, provider: result.provider, verifiedAt: verifiedAt.toISOString(), settings: Object.fromEntries(DEPOT_FIELDS.map((field) => [field, org[field]])) });
  } catch (err) { handleError(res, err); }
});

router.put("/organizations/:id/settings", requireRole("admin"), async (req, res): Promise<void> => {
  if (req.params.id !== req.user!.organizationId) { res.status(404).json({ error: "Organization not found" }); return; }
  try {
    const orgId = req.user!.organizationId;
    const updates: Record<string, unknown> = {};
    if (req.body.customerNotifications !== undefined) {
      const parsed = customerNotificationConfigSchema.safeParse(req.body.customerNotifications);
      if (!parsed.success) { res.status(400).json({ error: "Kontrollera meddelandemallarna och deras fält.", details: parsed.error.issues }); return; }
      updates.customerNotifications = parsed.data;
    }

    // Validate operatingMode before building updates
    if (req.body.operatingMode !== undefined) {
      const parsed = OperatingModeSchema.safeParse(req.body.operatingMode);
      if (!parsed.success) {
        res.status(400).json({
          error: `Invalid operatingMode: must be one of ${OPERATING_MODE_VALUES.join(", ")}`,
        });
        return;
      }
      updates.operatingMode = parsed.data;
    }

    const retentionSettings = StopRetentionSettingsSchema.safeParse({
      stopRetentionEnabled: req.body.stopRetentionEnabled,
      stopRetentionDays: req.body.stopRetentionDays,
    });
    if (!retentionSettings.success) {
      res.status(400).json({
        error: "Invalid stop retention settings",
        details: retentionSettings.error.issues,
      });
      return;
    }
    if (retentionSettings.data.stopRetentionEnabled !== undefined) {
      updates.stopRetentionEnabled = retentionSettings.data.stopRetentionEnabled;
    }
    if (retentionSettings.data.stopRetentionDays !== undefined) {
      updates.stopRetentionDays = retentionSettings.data.stopRetentionDays;
    }

    for (const f of SETTINGS_SCALAR_FIELDS) {
      if (req.body[f] !== undefined) updates[f] = req.body[f];
    }
    for (const field of ["maxDriverOvertimeMin", "allowLateStopsMin"] as const) {
      if (req.body[field] === undefined) continue;
      try {
        updates[field] = normalizePlanningAllowance(req.body[field], field);
      } catch {
        res.status(400).json({
          error: `${field} must be an integer between 0 and ${MAX_PLANNING_ALLOWANCE_MIN}.`,
        });
        return;
      }
    }

    const [org] = await db.update(organizationsTable).set(updates).where(eq(organizationsTable.id, orgId)).returning();
    if (!org) { res.status(404).json({ error: "Organization not found" }); return; }
    if (
      Object.prototype.hasOwnProperty.call(updates, "maxDriverOvertimeMin") ||
      Object.prototype.hasOwnProperty.call(updates, "allowLateStopsMin")
    ) {
      // This is derived feasibility evidence, so do not rewrite plan revision
      // or approval/handoff fields merely because the policy changed.
      await db
        .update(routesTable)
        .set({ geographicOverlapExplanation: null })
        .where(eq(routesTable.organizationId, orgId));
      broadcastDataChange(orgId, "policy", "updated", {
        fields: Object.keys(updates).filter(
          (field) => field === "maxDriverOvertimeMin" || field === "allowLateStopsMin",
        ),
      });
    }
    await logAdminEvent({
      req, action: "org.settings_update", resourceType: "organization", resourceId: orgId,
      statusCode: 200, diff: { fields: Object.keys(updates) },
    });
    res.json(org);
  } catch (err) { handleError(res, err); }
});

export default router;
