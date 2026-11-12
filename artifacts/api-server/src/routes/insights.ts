import { Router, type IRouter } from "express";
import { GetInsightsQueryParams } from "@workspace/api-zod";
import { handleError } from "../lib/errors";
import { generateInsights, enrichInsightsWithAI } from "../services/insights";
import { assertOrgScope } from "../middleware/auth";

const router: IRouter = Router();

router.get("/insights", async (req, res) => {
  try {
    const { organizationId: requestedOrganizationId, enhance: enhanceParam } = GetInsightsQueryParams.parse(req.query);
    const organizationId = assertOrgScope(req, requestedOrganizationId);
    const enhance = enhanceParam !== "false";
    const insights = await generateInsights(organizationId);
    const enriched = enhance ? await enrichInsightsWithAI(insights, organizationId) : insights;
    res.json({ insights: enriched, generatedAt: new Date().toISOString() });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
