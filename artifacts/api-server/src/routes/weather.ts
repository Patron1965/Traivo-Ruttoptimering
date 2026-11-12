import { Router } from "express";
import {
  getWeatherForLocation,
  getStockholmWeather,
  getWeatherSeverity,
} from "../services/weather-service";

const router = Router();

router.get("/weather/current", async (_req, res) => {
  try {
    const condition = await getStockholmWeather();
    res.json({
      ...condition,
      severity: getWeatherSeverity(condition),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch weather" });
  }
});

router.get("/weather/location", async (req, res) => {
  const lat = parseFloat(req.query.lat as string);
  const lng = parseFloat(req.query.lng as string);

  if (isNaN(lat) || isNaN(lng)) {
    res.status(400).json({ error: "lat and lng required" });
    return;
  }

  try {
    const condition = await getWeatherForLocation(lat, lng);
    res.json({
      ...condition,
      severity: getWeatherSeverity(condition),
      timestamp: new Date().toISOString(),
    });
  } catch (err) {
    res.status(500).json({ error: "Failed to fetch weather" });
  }
});

export default router;
