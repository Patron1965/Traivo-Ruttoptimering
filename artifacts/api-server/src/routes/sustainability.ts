import { Router, type IRouter } from "express";
import { GetSustainabilityStatsQueryParams } from "@workspace/api-zod";
import { handleError } from "../lib/errors";
import { calculateSustainabilityStats } from "../services/sustainability";

const router: IRouter = Router();

router.get("/sustainability/stats", async (req, res) => {
  try {
    const { organizationId } = GetSustainabilityStatsQueryParams.parse(req.query);
    const stats = await calculateSustainabilityStats(organizationId);
    res.json(stats);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
