import { Router, type IRouter } from "express";
import { eq, and, desc } from "drizzle-orm";
import { db, deliveryNotificationsTable, stopsTable, routesTable } from "@workspace/db";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

router.get("/delivery-notifications", async (req, res) => {
  try {
    const routeId = req.query.routeId as string;
    const stopId = req.query.stopId as string;
    const organizationId = req.user!.organizationId;

    if (!routeId && !stopId) {
      res.status(400).json({ error: "routeId or stopId is required" });
      return;
    }

    if (routeId && organizationId) {
      const [route] = await db
        .select({ id: routesTable.id })
        .from(routesTable)
        .where(and(eq(routesTable.id, routeId), eq(routesTable.organizationId, organizationId)));
      if (!route) {
        res.status(404).json({ error: "Route not found" });
        return;
      }
    }

    const conditions = [];
    if (routeId) conditions.push(eq(deliveryNotificationsTable.routeId, routeId));
    if (stopId) conditions.push(eq(deliveryNotificationsTable.stopId, stopId));

    const notifications = await db
      .select()
      .from(deliveryNotificationsTable)
      .where(and(...conditions))
      .orderBy(desc(deliveryNotificationsTable.sentAt))
      .limit(100);

    res.json(notifications);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/delivery-notifications", async (req, res) => {
  try {
    const { stopId, routeId, type, channel, message } = req.body;
    if (!stopId || !type) {
      res.status(400).json({ error: "stopId and type are required" });
      return;
    }

    const [stop] = await db
      .select({ id: stopsTable.id, routeId: stopsTable.routeId })
      .from(stopsTable)
      .where(eq(stopsTable.id, stopId));
    if (!stop) {
      res.status(404).json({ error: "Stop not found" });
      return;
    }

    if (routeId && stop.routeId !== routeId) {
      res.status(400).json({ error: "Stop does not belong to the specified route" });
      return;
    }

    const [notification] = await db
      .insert(deliveryNotificationsTable)
      .values({ stopId, routeId: routeId || stop.routeId, type, channel: channel || "system", message })
      .returning();
    res.status(201).json(notification);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
