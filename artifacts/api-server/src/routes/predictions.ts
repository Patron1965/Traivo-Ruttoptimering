import { Router, type IRouter } from "express";
import { generatePredictions } from "../services/prediction";

const router: IRouter = Router();

function parseBounds(raw: string) {
  const parts = raw.split(",").map(Number);
  if (parts.length !== 4 || parts.some(isNaN)) {
    return null;
  }
  return { lat1: parts[0], lng1: parts[1], lat2: parts[2], lng2: parts[3] };
}

router.get("/predictions/traffic", (req, res) => {
  const boundsRaw = req.query.bounds as string | undefined;
  if (!boundsRaw) {
    res.status(400).json({ error: "bounds query parameter is required (lat1,lng1,lat2,lng2)" });
    return;
  }

  const bounds = parseBounds(boundsRaw);
  if (!bounds) {
    res.status(400).json({ error: "bounds must be lat1,lng1,lat2,lng2" });
    return;
  }

  const horizon = parseInt(req.query.horizon as string) || 30;
  const predictions = generatePredictions(bounds, Math.max(0, Math.min(horizon, 240)));

  res.json(predictions);
});

export default router;
