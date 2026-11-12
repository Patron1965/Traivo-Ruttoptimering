import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { logger } from "../lib/logger";
import {
  AdjustAssignedRoutesBody,
  AdjustAssignedRoutesResponse,
  CreateImportRoutePlanBody,
  CreateImportRoutePlanResponse,
  ReoptimizeImportRoutePlanBody,
  ReoptimizeImportRoutePlanParams,
  ReoptimizeImportRoutePlanResponse,
  ReoptimizeImportRoutePlanPlanningInputsBody,
  ReoptimizeImportRoutePlanPlanningInputsParams,
  ReoptimizeImportRoutePlanPlanningInputsResponse,
  GetImportRoutePlanPlanningSummaryParams,
  GetImportRoutePlanPlanningSummaryResponse,
  PreviewImportRoutePlanReoptimizationBody,
  ApplyImportRoutePlanReoptimizationBody,
  PreviewImportRoutePlanReoptimizationResponse,
  ApplyImportRoutePlanReoptimizationResponse,
  GetImportRoutePlanProgressResponse,
  CreateRoutePlanStopBody,
  CreateRoutePlanStopResponse,
} from "@workspace/api-zod";
import { assertOrgScope, getOrgId, requireRole } from "../middleware/auth";
import {
  adjustAssignedRoutes,
  previewAssignedRouteAdjustments,
  createImportRoutePlan,
  getImportRoutePlanProgress,
  ImportRouteWorkflowError,
  reoptimizeImportRoutePlanServiceTime,
  reoptimizeImportRoutePlanPlanningInputs,
  planningSummaryForResponse,
  updatePlanSharedInstructions,
  previewWholePlanReoptimization,
  applyWholePlanReoptimization,
  type WholePlanReoptimizationInput,
} from "../services/import-route-workflow";
import { db, planningDraftsTable, routesTable } from "@workspace/db";
import { and, eq, ne } from "drizzle-orm";
import { PlanningDraftError } from "../services/planning-draft-service";
import {
  applyVerifiedNavigationDestination,
  cleanNavigationVerification,
  createStop,
  PlanStopConflictError,
} from "../services/stop-service";
import { geocodeAddress } from "../services/geocoding";
import {
  approveRoutePlan,
  getRoutePlanApprovalState,
  optimizationDriverIdForRoute,
  RoutePlanApprovalError,
} from "../services/route-plan-approval-service";

const router: IRouter = Router();
const RoutePlanApprovalBody = z
  .object({
    routes: z
      .array(
        z
          .object({
            routeId: z.guid(),
            planRevision: z.number().int().nonnegative(),
            driverId: z.guid(),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
const RoutePlanParams = z.object({ planId: z.guid() }).strict();

router.post("/import/route-plans/:planId/stops", requireRole("admin", "dispatcher"), async (req, res): Promise<void> => {
  const params = RoutePlanParams.safeParse(req.params);
  const parsed = CreateRoutePlanStopBody.safeParse(req.body);
  if (!params.success || !parsed.success) {
    res.status(400).json({ error: "Ogiltiga stopp- eller planuppgifter." });
    return;
  }
  const { stop, routes } = parsed.data;
  if (stop.routeId != null || !stop.address?.trim() ||
    (stop.latitude != null && (!Number.isFinite(stop.latitude) || Math.abs(stop.latitude) > 90)) ||
    (stop.longitude != null && (!Number.isFinite(stop.longitude) || Math.abs(stop.longitude) > 180))) {
    res.status(400).json({ error: "Stoppet måste ha giltig adress och koordinater och får inte redan vara tilldelat." });
    return;
  }
  try {
    const organizationId = assertOrgScope(req, stop.organizationId);
    const geocoded = await geocodeAddress(stop.address);
    const latitude = stop.latitude ?? geocoded?.latitude;
    const longitude = stop.longitude ?? geocoded?.longitude;
    if (latitude == null || longitude == null) {
      res.status(400).json({ error: "Adressen kunde inte koordinatsättas. Ange latitud och longitud." });
      return;
    }
    const values: Record<string, unknown> = { ...stop, organizationId, latitude, longitude };
    cleanNavigationVerification(values);
    if (geocoded) applyVerifiedNavigationDestination(values, geocoded);
    if (stop.pickupAddress) {
      if (stop.pickupLatitude == null || stop.pickupLongitude == null) {
        const pickup = await geocodeAddress(stop.pickupAddress);
        if (!pickup) {
          res.status(400).json({ error: "Hämtningsadressen kunde inte koordinatsättas." });
          return;
        }
        values.pickupLatitude = pickup.latitude;
        values.pickupLongitude = pickup.longitude;
      } else if (Math.abs(stop.pickupLatitude) > 90 || Math.abs(stop.pickupLongitude) > 180) {
        res.status(400).json({ error: "Ogiltiga koordinater för hämtningsadressen." });
        return;
      }
    }
    const created = await createStop({
      ...values,
      ...(stop.planningDate ? { planningDate: new Date(stop.planningDate) } : {}),
    }, { planId: params.data.planId, routes });
    res.status(201).json(CreateRoutePlanStopResponse.parse(created));
  } catch (error) {
    if (error instanceof PlanStopConflictError) {
      res.status(error.statusCode).json({ error: error.message });
      return;
    }
    throw error;
  }
});

function wholePlanInput(
  value: {
    draftId?: string | null;
    draftRevision?: number | null;
    routes: WholePlanReoptimizationInput["routes"];
    pairs?: WholePlanReoptimizationInput["pairs"];
    depotLatitude: number;
    depotLongitude: number;
  },
): WholePlanReoptimizationInput {
  return {
    draftId: value.draftId,
    draftRevision: value.draftRevision,
    routes: value.routes,
    pairs: value.pairs,
    depotLatitude: value.depotLatitude,
    depotLongitude: value.depotLongitude,
  };
}

router.post(
  "/import/route-plans",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const parsed = CreateImportRoutePlanBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    try {
      const result = await createImportRoutePlan(getOrgId(req), {
        ...parsed.data,
        draftId: parsed.data.draftId ?? undefined,
        progressId: parsed.data.progressId ?? undefined,
      });
      res.json(CreateImportRoutePlanResponse.parse(result));
    } catch (error) {
      if (
        error instanceof ImportRouteWorkflowError ||
        error instanceof PlanningDraftError
      ) {
        const body: {
          error: string;
          code?: string;
          details?: unknown;
        } = { error: error.message };
        if (error.code) body.code = error.code;
        if (error.details !== undefined) body.details = error.details;
        res.status(error.statusCode).json(body);
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/import/route-plans/progress/:progressId",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const progressId = z.guid().safeParse(req.params.progressId);
    if (!progressId.success) {
      res.status(400).json({ error: progressId.error.message });
      return;
    }
    const result = await getImportRoutePlanProgress(
      getOrgId(req),
      progressId.data,
    );
    if (!result) {
      res.status(404).json({ error: "Importförloppet saknas." });
      return;
    }
    res.json(GetImportRoutePlanProgressResponse.parse(result));
  },
);

router.post(
  "/import/route-plans/:planId/reoptimization/preview",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = RoutePlanParams.safeParse(req.params);
    const body = PreviewImportRoutePlanReoptimizationBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: !params.success
          ? params.error.message
          : (body.error?.message ?? "Ogiltig begäran."),
      });
      return;
    }
    try {
      const result = await previewWholePlanReoptimization(
        getOrgId(req),
        params.data.planId,
        wholePlanInput(body.data),
      );
      res.json(PreviewImportRoutePlanReoptimizationResponse.parse(result));
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
  "/import/route-plans/:planId/reoptimization/apply",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = RoutePlanParams.safeParse(req.params);
    const body = ApplyImportRoutePlanReoptimizationBody.safeParse(req.body);
    if (!params.success || !body.success) {
      res.status(400).json({
        error: !params.success
          ? params.error.message
          : (body.error?.message ?? "Ogiltig begäran."),
      });
      return;
    }
    try {
      const result = await applyWholePlanReoptimization(
        getOrgId(req),
        params.data.planId,
        {
          ...wholePlanInput(body.data),
          proposalHash: body.data.proposalHash,
        },
      );
      res.json(ApplyImportRoutePlanReoptimizationResponse.parse(result));
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
  "/import/route-adjustments/preview",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const parsed = AdjustAssignedRoutesBody.safeParse(req.body);
    if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
    try {
      res.json(await previewAssignedRouteAdjustments(getOrgId(req), parsed.data));
    } catch (error) {
      if (error instanceof ImportRouteWorkflowError) {
        res.status(error.statusCode).json({ code: "IMPORT_PLAN_REVIEW_FAILED", error: error.message }); return;
      }
      throw error;
    }
  },
);

router.post(
  "/import/route-adjustments",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const parsed = AdjustAssignedRoutesBody.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: parsed.error.message });
      return;
    }

    try {
      const result = await adjustAssignedRoutes(getOrgId(req), parsed.data);
      res.json(AdjustAssignedRoutesResponse.parse(result));
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
  "/import/route-plans/:planId/reoptimize-service-time",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = ReoptimizeImportRoutePlanParams.safeParse(req.params);
    const body = ReoptimizeImportRoutePlanBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    try {
      const result = await reoptimizeImportRoutePlanServiceTime(
        getOrgId(req),
        params.data.planId,
        body.data,
      );
      res.json(ReoptimizeImportRoutePlanResponse.parse(result));
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
  "/import/route-plans/:planId/reoptimize-planning-inputs",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = ReoptimizeImportRoutePlanPlanningInputsParams.safeParse(
      req.params,
    );
    const body = ReoptimizeImportRoutePlanPlanningInputsBody.safeParse(
      req.body,
    );
    if (!params.success || !body.success) {
      res
        .status(400)
        .json({
          error: !params.success
            ? params.error.message
            : (body.error?.message ?? "Ogiltig begäran."),
        });
      return;
    }
    try {
      // The service compares canonical/effective inputs while holding the
      // draft, route and stop locks. Never use JSON.stringify/jsonb ordering
      // to decide whether this can be an instruction-only revision.
      let result;
      const hasSharedInstructions = Object.prototype.hasOwnProperty.call(
        body.data,
        "sharedInstructions",
      );
      // An empty protected plan has no route row for the instruction-only
      // updater to lock. Let the protected recovery transaction own both the
      // instruction and restored planning inputs instead.
      const hasLiveRoutes =
        hasSharedInstructions &&
        (
          await db
            .select({
              id: routesTable.id,
            })
            .from(routesTable)
            .where(
              and(
                eq(routesTable.organizationId, getOrgId(req)),
                eq(routesTable.planId, params.data.planId),
                ne(routesTable.status, "cancelled"),
              ),
            )
            .limit(1)
        ).length > 0;
      if (hasSharedInstructions && hasLiveRoutes) {
        const instructionResult = await updatePlanSharedInstructions(
          getOrgId(req),
          params.data.planId,
          body.data.draftId,
          body.data.draftRevision,
          body.data.sharedInstructions ?? null,
          body.data.planningInputs,
        );
        result = instructionResult.needsReoptimization
          ? await reoptimizeImportRoutePlanPlanningInputs(
              getOrgId(req),
              params.data.planId,
              body.data,
            )
          : instructionResult;
      } else {
        result = await reoptimizeImportRoutePlanPlanningInputs(
          getOrgId(req),
          params.data.planId,
          body.data,
        );
      }
      const response =
        "needsReoptimization" in result && result.needsReoptimization === false
          ? {
              ...result,
              routes: result.routes.map((route) => ({
                routeId: route.id,
                planRevision: route.planRevision,
                status: route.status,
              })),
            }
          : {
              ...result,
              routes: (
                result as Awaited<
                  ReturnType<typeof reoptimizeImportRoutePlanPlanningInputs>
                >
              ).routes.map((route) => ({
                routeId: route.routeId,
                planRevision: route.planRevision,
                status: route.status,
              })),
            };
      res.json(ReoptimizeImportRoutePlanPlanningInputsResponse.parse(response));
    } catch (error) {
      // Log a safe failure classification without stop data, addresses or raw
      // database/provider messages. These failures previously had no plan-level trace.
      logger.error({
        event: "planning_inputs_reoptimization_failed",
        planId: params.data.planId,
        objective: body.data.planningInputs?.objective,
        errorType: error instanceof Error ? error.name : "Unknown",
        statusCode: error instanceof ImportRouteWorkflowError ? error.statusCode : 500,
      }, "Planning-input reoptimization failed");
      if (error instanceof ImportRouteWorkflowError) {
        res.status(error.statusCode).json({ error: error.message });
        return;
      }
      throw error;
    }
  },
);

router.get(
  "/import/route-plans/:planId/planning-summary",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = GetImportRoutePlanPlanningSummaryParams.safeParse(
      req.params,
    );
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    const routes = await db
      .select()
      .from(routesTable)
      .where(
        and(
          eq(routesTable.organizationId, getOrgId(req)),
          eq(routesTable.planId, params.data.planId),
          ne(routesTable.status, "cancelled"),
        ),
      );
    const [draft] =
      routes.length === 0
        ? await db
            .select()
            .from(planningDraftsTable)
            .where(
              and(
                eq(planningDraftsTable.organizationId, getOrgId(req)),
                eq(planningDraftsTable.planId, params.data.planId),
              ),
            )
            .limit(1)
        : [];
    const [routeDraft] =
      routes.length > 0 && routes[0].draftId
        ? await db
            .select()
            .from(planningDraftsTable)
            .where(
              and(
                eq(planningDraftsTable.id, routes[0].draftId),
                eq(planningDraftsTable.organizationId, getOrgId(req)),
                eq(planningDraftsTable.planId, params.data.planId),
              ),
            )
            .limit(1)
        : [];
    const authoritativeDraft = routeDraft ?? draft;
    if (routes.length === 0 && !authoritativeDraft?.planResult) {
      res.status(404).json({ error: "Ruttplanen saknas." });
      return;
    }
    const first = routes[0];
    const stored = authoritativeDraft?.planResult ?? {};
    res.json(
      GetImportRoutePlanPlanningSummaryResponse.parse({
        planId: params.data.planId,
         draftId: first?.draftId ?? authoritativeDraft?.id ?? null,
        customerReference:
          first?.customerReference ??
          (typeof stored.customerReference === "string"
            ? stored.customerReference
            : null),
        sharedInstructions:
          first?.sharedInstructions ??
          (typeof stored.sharedInstructions === "string"
            ? stored.sharedInstructions
            : null),
        planningInputs:
           authoritativeDraft?.state.planningInputs ??
           stored.planningInputs ??
           first?.optimizationPlanningSnapshot ??
          null,
        planningSummary: planningSummaryForResponse(
          first?.planningSummary ?? stored.planningSummary ?? null,
        ),
        routes: routes.map((route) => ({
          routeId: route.id,
          planId: route.planId,
          draftId: route.draftId,
          planRevision: route.planRevision,
          status: route.status,
          vehicleId: route.vehicleId,
          driverId:
            route.handoffDriverId ?? optimizationDriverIdForRoute(route),
          approval: {
            approved: false,
            approvedAt: null,
            approvedByUserId: null,
          },
        })),
      }),
    );
  },
);

router.get(
  "/import/route-plans/:planId/approval",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = RoutePlanParams.safeParse(req.params);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    try {
      res.json(
        await getRoutePlanApprovalState(getOrgId(req), params.data.planId),
      );
    } catch (error) {
      if (error instanceof RoutePlanApprovalError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      throw error;
    }
  },
);

router.post(
  "/import/route-plans/:planId/approve",
  requireRole("admin", "dispatcher"),
  async (req, res): Promise<void> => {
    const params = RoutePlanParams.safeParse(req.params);
    const body = RoutePlanApprovalBody.safeParse(req.body);
    if (!params.success) {
      res.status(400).json({ error: params.error.message });
      return;
    }
    if (!body.success) {
      res.status(400).json({ error: body.error.message });
      return;
    }
    try {
      res.json(
        await approveRoutePlan(
          getOrgId(req),
          params.data.planId,
          req.user!.id,
          body.data.routes,
        ),
      );
    } catch (error) {
      if (error instanceof RoutePlanApprovalError) {
        res.status(error.statusCode).json({
          error: error.message,
          code: error.code,
        });
        return;
      }
      throw error;
    }
  },
);

export default router;
