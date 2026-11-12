import { Router, type IRouter } from "express";
import healthRouter from "./health";
import { driverAccessRouter } from "./driver-access";
import portalAdminRouter from "./portal-admin";
import vehiclesRouter from "./vehicles";
import stopsRouter from "./stops";
import routesRouter from "./routes";
import routeOutgoingRouter from "./route-outgoing";
import dashboardRouter from "./dashboard";
import optimizeRouter from "./optimize";
import sustainabilityRouter from "./sustainability";
import aiChatRouter from "./ai-chat";
import insightsRouter from "./insights";
import driversRouter from "./drivers";
import trackingRouter from "./tracking";
import notificationsRouter from "./notifications";
import publicTrackingRouter from "./public-tracking";
import customerLinksRouter from "./customer-links";
import osrmRouter from "./osrm";
import usersRouter from "./users";
import authRouter from "./auth";
import driverStatsRouter from "./driver-stats";
import routeTemplatesRouter from "./route-templates";
import deliveryNotificationsRouter from "./delivery-notifications";
import analyticsRouter from "./analytics";
import driverPreferencesRouter from "./driver-preferences";
import predictionsRouter from "./predictions";
import energyRouter from "./energy";
import voiceRouter from "./voice";
import storageRouter from "./storage";
import proofRouter from "./proof";
import webhooksRouter from "./webhooks";
import shopifyRouter from "./shopify";
import subscriptionsRouter from "./subscriptions";
import weatherRouter from "./weather";
import trafficRouter from "./traffic";
import driverLearningRouter from "./driver-learning";
import orgSettingsRouter from "./org-settings";
import userGroupsRouter from "./user-groups";
import appUsersRouter from "./app-users";
import reportsRouter from "./reports";
import geocodingRouter from "./geocoding";
import kpiRouter from "./kpi";
import erpImportRouter from "./erp-import";
import auditLogRouter from "./audit-log";
import exportRouter from "./export";
import documentsRouter from "./documents";
import importRouteWorkflowRouter from "./import-route-workflow";
import fieldServiceRouter from "./field-service";
import routeExecutionRouter from "./route-execution";
import stopMessagesRouter from "./stop-messages";
import exceptionsRouter from "./exceptions";
import planningDraftsRouter from "./planning-drafts";
import plannerCorrectionsRouter from "./planner-corrections";
import districtRouter from "./district";
import districtIntakeRouter from "./district-intake";
import customersRouter from "./customers";
import brandingRouter from "./branding";
import platformRouter from "./platform";
import { requireAuth, authorizeWrite } from "../middleware/auth";
import { randomUUID } from "node:crypto";
import { runWithUsageContext } from "../services/usage-context";
import { loadOrganizationServicePolicy } from "../services/organization-service-policy";
import { handleError } from "../lib/errors";
import { outgoingDriverReads } from "../middleware/outgoing-driver-reads";
import smsRouter from "./sms";

const router: IRouter = Router();

const PUBLIC_PATTERNS: RegExp[] = [
  /^\/healthz\/?$/,
  /^\/auth\/(?:login|logout|me|forgot-password|reset-password)\/?$/,
  /^\/auth\/mfa\/(?:status|enroll|verify|resend|operator-recovery)\/?$/,
  /^\/auth\/driver-link\/?$/,
  /^\/track\/[^/]+\/?$/,
  /^\/osrm\/route\/?$/,
  /^\/storage\/public-objects\/.+$/,
  /^\/branding\/public\/[^/]+\/(?:light|dark)\/?$/,
];

/**
 * Only endpoints that are deliberately externally consumable bypass the
 * application session gate. Router paths are relative to `/api`.
 */
export function isPublicApiPath(path: string): boolean {
  const normalizedPath = path.replace(/^\/api(?=\/|$)/, "");
  return PUBLIC_PATTERNS.some((re) => re.test(normalizedPath));
}

router.use((req, res, next) => {
  if (isPublicApiPath(req.path) || isPublicApiPath(req.originalUrl)) {
    next();
    return;
  }
  requireAuth()(req, res, next);
});

router.use(driverAccessRouter);
router.use(authorizeWrite());
router.use(outgoingDriverReads);

// The authenticated session, never a client-supplied organization ID, owns
// all provider calls made by this request (including import preprocessing).
router.use(async (req, res, next) => {
  if (!req.user) { next(); return; }
  try {
    const servicePolicy = await loadOrganizationServicePolicy(req.user.organizationId);
    runWithUsageContext(
      { organizationId: req.user.organizationId, jobId: randomUUID(), servicePolicy },
      next,
    );
  } catch (error) { handleError(res, error); }
});

router.use(healthRouter);
router.use(portalAdminRouter);
router.use(smsRouter);
router.get("/organization/capabilities", async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    const policy = await loadOrganizationServicePolicy(req.user!.organizationId);
    res.json({ districtEnabled: policy.districtEnabled });
  } catch (error) { handleError(res, error); }
});
router.use(storageRouter);
router.use(proofRouter);
router.use(authRouter);
router.use(usersRouter);
router.use(platformRouter);
router.use(trackingRouter);
router.use(brandingRouter);
router.use(vehiclesRouter);
router.use(stopsRouter);
router.use(customerLinksRouter);
router.use(routeOutgoingRouter);
router.use(routesRouter);
router.use(dashboardRouter);
router.use(optimizeRouter);
router.use(sustainabilityRouter);
router.use(aiChatRouter);
router.use(insightsRouter);
router.use(driversRouter);
router.use(driverStatsRouter);
router.use(notificationsRouter);
router.use(publicTrackingRouter);
router.use(osrmRouter);
router.use(routeTemplatesRouter);
router.use(deliveryNotificationsRouter);
router.use(analyticsRouter);
router.use(driverPreferencesRouter);
router.use(predictionsRouter);
router.use(energyRouter);
router.use(voiceRouter);
router.use(webhooksRouter);
router.use(shopifyRouter);
router.use(subscriptionsRouter);
router.use(weatherRouter);
router.use(trafficRouter);
router.use(driverLearningRouter);
router.use(orgSettingsRouter);
router.use(userGroupsRouter);
router.use(appUsersRouter);
router.use(reportsRouter);
router.use(geocodingRouter);
router.use(kpiRouter);
router.use(erpImportRouter);
router.use(auditLogRouter);
router.use(exportRouter);
router.use(documentsRouter);
router.use(importRouteWorkflowRouter);
router.use(fieldServiceRouter);
router.use(routeExecutionRouter);
router.use(stopMessagesRouter);
router.use(exceptionsRouter);
router.use(planningDraftsRouter);
router.use(plannerCorrectionsRouter);
router.use(districtRouter);
router.use(districtIntakeRouter);
router.use(customersRouter);

export default router;
