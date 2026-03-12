import { Router, type IRouter } from "express";
import { eq, and, desc, sql, count } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";

const router: IRouter = Router();

router.get("/notifications", async (req, res) => {
  try {
    const organizationId = req.query.organizationId as string;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;

    const [unreadCount] = await db
      .select({ count: count() })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.organizationId, organizationId),
          eq(notificationsTable.isRead, false)
        )
      );

    const notifications = await db
      .select()
      .from(notificationsTable)
      .where(eq(notificationsTable.organizationId, organizationId))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(limit);

    res.json({
      unreadCount: unreadCount?.count ?? 0,
      notifications,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/notifications/:id/read", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.query.organizationId as string;
    const conditions = organizationId
      ? and(eq(notificationsTable.id, id), eq(notificationsTable.organizationId, organizationId))
      : eq(notificationsTable.id, id);
    const [notification] = await db
      .update(notificationsTable)
      .set({ isRead: true })
      .where(conditions)
      .returning();
    if (!notification) {
      res.status(404).json({ error: "Notification not found" });
      return;
    }
    res.json(notification);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/notifications/read-all", async (req, res) => {
  try {
    const organizationId = req.query.organizationId as string;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    await db
      .update(notificationsTable)
      .set({ isRead: true })
      .where(
        and(
          eq(notificationsTable.organizationId, organizationId),
          eq(notificationsTable.isRead, false)
        )
      );
    res.json({ success: true });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
