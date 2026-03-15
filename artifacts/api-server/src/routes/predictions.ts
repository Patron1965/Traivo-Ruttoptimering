import { Router, type IRouter } from "express";
import { z } from "zod/v4";
import { generatePredictions } from "../services/prediction";

const router: IRouter = Router();

const boundsSchema = z.string().transform((val) => {
  const parts = val.split(",").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    throw new Error("bounds must be lat1,lng1,lat2,lng2");
  }
  return { lat1: parts[0], lng1: parts[1], lat2: parts[2], lng2: parts[3] };
});

router.get("/predictions/traffic", (req, res) => {
  try {
    const boundsRaw = req.query.bounds as string;
    if (!boundsRaw) {
      res.status(400).json({ error: "bounds query parameter is required (lat1,lng1,lat2,lng2)" });
      return;
    }

    const bounds = boundsSchema.parse(boundsRaw);
    const horizon = parseInt(req.query.horizon as string) || 30;

    const predictions = generatePredictions(bounds, Math.max(0, Math.min(horizon, 240)));

    res.json({
      predictions,
      meta: {
        horizonMinutes: horizon,
        generatedAt: new Date().toISOString(),
        cellCount: predictions.length,
      },
    });
  } catch (err: any) {
    res.status(400).json({ error: err.message || "Invalid request" });
  }
});

export default router;
