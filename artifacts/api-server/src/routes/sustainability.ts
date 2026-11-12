import { Router, type IRouter } from "express";
import { GetSustainabilityStatsQueryParams } from "@workspace/api-zod";
import { handleError } from "../lib/errors";
import { calculateSustainabilityStats } from "../services/sustainability";
import { assertOrgScope } from "../middleware/auth";

const router: IRouter = Router();

router.get("/sustainability/stats", async (req, res) => {
  try {
    const { organizationId: requestedOrganizationId } = GetSustainabilityStatsQueryParams.parse(req.query);
    const organizationId = assertOrgScope(req, requestedOrganizationId);
    const stats = await calculateSustainabilityStats(organizationId);
    res.json(stats);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
