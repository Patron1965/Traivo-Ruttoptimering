import { Router, type Request, type Response } from "express";

const router = Router();

router.get("/osrm/route", async (req: Request, res: Response) => {
  const coords = req.query.coords as string;
  if (!coords) {
    res.status(400).json({ error: "coords query parameter required" });
    return;
  }

  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?overview=full&geometries=polyline`;

  try {
    const response = await fetch(url);
    const data = await response.json();
    res.json(data);
  } catch {
    res.status(502).json({ code: "Error", message: "OSRM request failed" });
  }
});

export default router;
