import { Router, type IRouter } from "express";
import { getCurrentPrice, getPrices, getOptimalChargingWindow } from "../services/electricity";

const router: IRouter = Router();

router.get("/energy/prices", async (req, res) => {
  const area = (req.query.area as string) || "SE3";
  const hours = Math.min(168, Math.max(1, parseInt(req.query.hours as string) || 24));

  const prices = await getPrices(area, hours);
  res.json(prices);
});

router.get("/energy/current", async (req, res) => {
  const area = (req.query.area as string) || "SE3";
  const price = await getCurrentPrice(area);
  res.json(price);
});

router.get("/energy/optimal-window", async (req, res) => {
  const area = (req.query.area as string) || "SE3";
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
});

export default router;
