import { Router, type IRouter } from "express";
import { eq, and, isNull } from "drizzle-orm";
import { db, routesTable, stopsTable } from "@workspace/db";
import {
  CreateRouteBody,
  UpdateRouteBody,
  ListRoutesQueryParams,
} from "@workspace/api-zod";
import { handleError, parseUuidParam } from "../lib/errors";

const router: IRouter = Router();

router.get("/routes", async (req, res) => {
  try {
    const { organizationId } = ListRoutesQueryParams.parse(req.query);
    const routes = await db
      .select()
      .from(routesTable)
      .where(eq(routesTable.organizationId, organizationId));
    res.json(routes);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = req.query.organizationId as string | undefined;
    const conditions = [eq(routesTable.id, id)];
    if (orgId) conditions.push(eq(routesTable.organizationId, orgId));
    const [route] = await db
      .select()
      .from(routesTable)
      .where(and(...conditions));
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(route);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/routes", async (req, res) => {
  try {
    const data = CreateRouteBody.parse(req.body);
    const [route] = await db.insert(routesTable).values(data).returning();
    res.status(201).json(route);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/routes/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const data = UpdateRouteBody.parse(req.body);
    const orgId = req.query.organizationId as string | undefined;
    const conditions = [eq(routesTable.id, id)];
    if (orgId) conditions.push(eq(routesTable.organizationId, orgId));
    const [route] = await db
      .update(routesTable)
      .set({ ...data, updatedAt: new Date() })
      .where(and(...conditions))
      .returning();
    if (!route) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.json(route);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/routes/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = req.query.organizationId as string | undefined;
    const conditions = [eq(routesTable.id, id)];
    if (orgId) conditions.push(eq(routesTable.organizationId, orgId));

    await db
      .update(stopsTable)
      .set({ routeId: null, sequenceOrder: null })
      .where(eq(stopsTable.routeId, id));

    const [deleted] = await db
      .delete(routesTable)
      .where(and(...conditions))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Route not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/routes/:id/stops", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const stops = await db
      .select()
      .from(stopsTable)
      .where(eq(stopsTable.routeId, id))
      .orderBy(stopsTable.sequenceOrder);
    res.json(stops);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
