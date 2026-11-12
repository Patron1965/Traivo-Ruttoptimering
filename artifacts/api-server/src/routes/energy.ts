import { Router, type IRouter } from "express";
import { getCurrentPrice, getPrices, getOptimalChargingWindow } from "../services/electricity";
import { handleError } from "../lib/errors";

const router: IRouter = Router();
const VALID_AREAS = ["SE1", "SE2", "SE3", "SE4"];

function validateArea(area: string): string {
  const upper = area.toUpperCase();
  return VALID_AREAS.includes(upper) ? upper : "SE3";
}

router.get("/energy/prices", async (req, res) => {
  try {
    const area = validateArea((req.query.area as string) || "SE3");
    const hours = Math.min(168, Math.max(1, parseInt(req.query.hours as string) || 24));

    const prices = await getPrices(area, hours);
    res.json(prices);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/energy/current", async (req, res) => {
  try {
    const area = validateArea((req.query.area as string) || "SE3");
    const price = await getCurrentPrice(area);
    res.json(price);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/energy/optimal-window", async (req, res) => {
  try {
    const area = validateArea((req.query.area as string) || "SE3");
    const duration = Math.max(15, parseInt(req.query.duration as string) || 60);
    const deadlineStr = req.query.deadline as string;

    let deadline: Date;
    if (deadlineStr) {
      deadline = new Date(deadlineStr);
      if (isNaN(deadline.getTime())) {
        res.status(400).json({ error: "Invalid deadline format" });
        return;
      }
    } else {
      deadline = new Date(Date.now() + 24 * 3600000);
    }

    const window = await getOptimalChargingWindow(area, duration, deadline);
    res.json(window);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
