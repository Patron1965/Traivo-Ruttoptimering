import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { getOrgId, requireRole } from "../middleware/auth";
import { handleError } from "../lib/errors";
import { projectRouteForMap } from "../services/route-map-projection";
import {
  OutgoingVersionError, PlannerOutgoingScopeError,
  plannerOutgoingView, PLANNER_OUTGOING_SCOPE_LIMIT,
} from "../services/outgoing-route-service";

const router: IRouter = Router();
const Scope = z.object({
  routeIds: z.string().max(PLANNER_OUTGOING_SCOPE_LIMIT * 37)
    .transform((value) => value.split(","))
    .pipe(z.array(z.guid()).min(1).max(PLANNER_OUTGOING_SCOPE_LIMIT)),
});

// Includes contact/instruction evidence. Explicitly not available to viewers
// or drivers; driver reads already have their own recipient-scoped projection.
router.get("/routes/outgoing-view", requireRole("admin", "dispatcher"), async (req, res) => {
  res.set("Cache-Control", "no-store, private");
  try {
    const { routeIds } = Scope.parse(req.query);
    const view = await plannerOutgoingView(getOrgId(req), routeIds);
    res.json({ ...view, routes: view.routes.map(projectRouteForMap) });
  } catch (error) {
    if (error instanceof OutgoingVersionError || error instanceof PlannerOutgoingScopeError) {
      res.status(error.statusCode).json({
        error: error.message, code: error.code,
        ...("routeId" in error && typeof error.routeId === "string" ? { routeId: error.routeId } : {}),
      });
      return;
    }
    handleError(res, error);
  }
});

export default router;
