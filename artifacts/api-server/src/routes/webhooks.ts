import { Router, type IRouter } from "express";
import crypto from "crypto";
import { eq, and } from "drizzle-orm";
import { db, webhooksTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { dispatchTestToSingleHook } from "../services/webhooks";

const router: IRouter = Router();

const VALID_EVENTS = [
  "route.created", "route.optimized", "route.started", "route.completed", "route.cancelled",
  "stop.completed", "stop.failed", "stop.skipped",
  "vehicle.position", "notification.sent",
];

router.get("/webhooks", async (req, res) => {
  try {
    const orgId = req.query.organizationId as string;
    if (!orgId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const hooks = await db
      .select()
      .from(webhooksTable)
      .where(eq(webhooksTable.organizationId, orgId));
    res.json(hooks);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/webhooks/events", async (_req, res) => {
  res.json({ events: VALID_EVENTS });
});

router.post("/webhooks", async (req, res) => {
  try {
    const { organizationId, url, name, events, secret } = req.body;
    if (!organizationId || !url || !name) {
      res.status(400).json({ error: "organizationId, url, and name are required" });
      return;
    }

    let eventsStr = "*";
    if (events && events !== "*") {
      const eventList = Array.isArray(events)
        ? events.map((e: string) => e.trim())
        : events.split(",").map((e: string) => e.trim());
      const invalid = eventList.filter((e: string) => !VALID_EVENTS.includes(e));
      if (invalid.length > 0) {
        res.status(400).json({ error: `Invalid events: ${invalid.join(", ")}` });
        return;
      }
      eventsStr = eventList.join(",");
    }

    const webhookSecret = secret || crypto.randomBytes(32).toString("hex");

    const [hook] = await db
      .insert(webhooksTable)
      .values({
        organizationId,
        url,
        name,
        events: eventsStr,
        secret: webhookSecret,
      })
      .returning();

    res.status(201).json(hook);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/webhooks/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = req.query.organizationId as string;
    const { url, name, events, active, secret } = req.body;

    if (events !== undefined && events !== "*") {
      const eventList = Array.isArray(events)
        ? events.map((e: string) => e.trim())
        : events.split(",").map((e: string) => e.trim());
      const invalid = eventList.filter((e: string) => !VALID_EVENTS.includes(e));
      if (invalid.length > 0) {
        res.status(400).json({ error: `Invalid events: ${invalid.join(", ")}` });
        return;
      }
    }

    const updates: Record<string, unknown> = { updatedAt: new Date() };
    if (url !== undefined) updates.url = url;
    if (name !== undefined) updates.name = name;
    if (events !== undefined) {
      updates.events = Array.isArray(events) ? events.join(",") : events;
    }
    if (active !== undefined) updates.active = active;
    if (secret !== undefined) updates.secret = secret;

    const conditions = [eq(webhooksTable.id, id)];
    if (orgId) conditions.push(eq(webhooksTable.organizationId, orgId));

    const [hook] = await db
      .update(webhooksTable)
      .set(updates)
      .where(and(...conditions))
      .returning();

    if (!hook) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    res.json(hook);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/webhooks/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = req.query.organizationId as string;
    const conditions = [eq(webhooksTable.id, id)];
    if (orgId) conditions.push(eq(webhooksTable.organizationId, orgId));

    const [deleted] = await db
      .delete(webhooksTable)
      .where(and(...conditions))
      .returning();

    if (!deleted) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }
    res.json({ deleted: true });
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/webhooks/:id/test", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = req.query.organizationId as string;
    const conditions = [eq(webhooksTable.id, id)];
    if (orgId) conditions.push(eq(webhooksTable.organizationId, orgId));

    const [hook] = await db
      .select()
      .from(webhooksTable)
      .where(and(...conditions));

    if (!hook) {
      res.status(404).json({ error: "Webhook not found" });
      return;
    }

    await dispatchTestToSingleHook(hook);

    res.json({ sent: true });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
