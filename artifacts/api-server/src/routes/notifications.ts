import { Router, type IRouter } from "express";
import { eq, and, desc, sql, count, isNull, or } from "drizzle-orm";
import { db, notificationsTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";

const router: IRouter = Router();

router.get("/notifications", async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const limit = parseInt(req.query.limit as string) || 50;
    const since = typeof req.query.since === "string"
      ? new Date(req.query.since)
      : undefined;
    if (since && Number.isNaN(since.getTime())) {
      res.status(400).json({ error: "since must be a valid ISO timestamp" });
      return;
    }
    const visibleToUser = req.user!.role === "driver" ? eq(notificationsTable.recipientUserId, req.user!.id) : or(
      isNull(notificationsTable.recipientUserId),
      eq(notificationsTable.recipientUserId, req.user!.id),
    );
    const conditions = [
      eq(notificationsTable.organizationId, organizationId),
      visibleToUser,
    ];
    if (since) conditions.push(sql`${notificationsTable.createdAt} > ${since}`);

    const [unreadCount] = await db
      .select({ count: count() })
      .from(notificationsTable)
      .where(
        and(
          eq(notificationsTable.organizationId, organizationId),
          eq(notificationsTable.isRead, false),
          visibleToUser,
        )
      );

    const notifications = await db
      .select()
      .from(notificationsTable)
      .where(and(...conditions))
      .orderBy(desc(notificationsTable.createdAt))
      .limit(limit);

    res.json({
      unreadCount: Number(unreadCount?.count ?? 0),
      notifications,
    });
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/notifications/:id/read", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const [notification] = await db
      .update(notificationsTable)
      .set({ isRead: true })
      .where(
        and(
          eq(notificationsTable.id, id),
          eq(notificationsTable.organizationId, organizationId),
          or(
            isNull(notificationsTable.recipientUserId),
            eq(notificationsTable.recipientUserId, req.user!.id),
          ),
        )
      )
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
    const organizationId = req.user!.organizationId;
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
          eq(notificationsTable.isRead, false),
          or(
            isNull(notificationsTable.recipientUserId),
            eq(notificationsTable.recipientUserId, req.user!.id),
          ),
        )
      );
    res.json({ success: true });
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
