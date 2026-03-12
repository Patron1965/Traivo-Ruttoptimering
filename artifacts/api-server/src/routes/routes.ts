import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, routesTable, stopsTable } from "@workspace/db";
import {
  CreateRouteBody,
  UpdateRouteBody,
  ListRoutesQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/routes", async (req, res) => {
  try {
    const { organizationId } = ListRoutesQueryParams.parse(req.query);
    const routes = await db
      .select()
      .from(routesTable)
      .where(eq(routesTable.organizationId, organizationId));
    res.json(routes);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/routes/:id", async (req, res) => {
  try {
    const [route] = await db
      .select()
      .from(routesTable)
      .where(eq(routesTable.id, req.params.id));
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(route);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/routes", async (req, res) => {
  try {
    const data = CreateRouteBody.parse(req.body);
    const [route] = await db.insert(routesTable).values(data).returning();
    res.status(201).json(route);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/routes/:id", async (req, res) => {
  try {
    const data = UpdateRouteBody.parse(req.body);
    const [route] = await db
      .update(routesTable)
      .set({ ...data, updatedAt: new Date() })
      .where(eq(routesTable.id, req.params.id))
      .returning();
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(route);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/routes/:id", async (req, res) => {
  try {
    await db.delete(stopsTable).where(eq(stopsTable.routeId, req.params.id));
    const [deleted] = await db
      .delete(routesTable)
      .where(eq(routesTable.id, req.params.id))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.status(204).send();
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/routes/:id/stops", async (req, res) => {
  try {
    const stops = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, req.params.id))
      .orderBy(stopsTable.sequenceOrder);
    res.json(stops);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
