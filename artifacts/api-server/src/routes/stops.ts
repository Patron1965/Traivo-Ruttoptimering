import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, stopsTable } from "@workspace/db";
import {
  CreateStopBody,
  UpdateStopBody,
  ListStopsQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/stops", async (req, res) => {
  try {
    const { organizationId, routeId } = ListStopsQueryParams.parse(req.query);
    const conditions = [eq(stopsTable.organizationId, organizationId)];
    if (routeId) {
      conditions.push(eq(stopsTable.routeId, routeId));
    }
    const stops = await db
      .select()
      .from(stopsTable)
      .where(and(...conditions));
    res.json(stops);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/stops/:id", async (req, res) => {
  try {
    const [stop] = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.id, req.params.id));
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    res.json(stop);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/stops", async (req, res) => {
  try {
    const data = CreateStopBody.parse(req.body);
    const [stop] = await db.insert(stopsTable).values(data).returning();
    res.status(201).json(stop);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/stops/:id", async (req, res) => {
  try {
    const data = UpdateStopBody.parse(req.body);
    const [stop] = await db
      .update(stopsTable)
      .set(data)
      .where(eq(stopsTable.id, req.params.id))
      .returning();
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    res.json(stop);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/stops/:id", async (req, res) => {
  try {
    const [deleted] = await db
      .delete(stopsTable)
      .where(eq(stopsTable.id, req.params.id))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }
    res.status(204).send();
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
