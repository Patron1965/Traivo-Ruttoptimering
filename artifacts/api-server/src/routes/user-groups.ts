import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, userGroupsTable, usersTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { getOrgId, requireRole } from "../middleware/auth";
import { logAdminEvent } from "../lib/security-log";

const router: IRouter = Router();

router.get("/user-groups", requireRole("admin"), async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const groups = await db.select({
      id: userGroupsTable.id,
      organizationId: userGroupsTable.organizationId,
      name: userGroupsTable.name,
      createdAt: userGroupsTable.createdAt,
      memberCount: sql<number>`(SELECT COUNT(*) FROM users WHERE users.group_id = ${userGroupsTable.id})::int`,
    }).from(userGroupsTable).where(eq(userGroupsTable.organizationId, orgId));
    res.json(groups);
  } catch (err) { handleError(res, err); }
});

router.post("/user-groups", requireRole("admin"), async (req, res) => {
  try {
    const orgId = req.user!.organizationId;
    const { name } = req.body;
    if (!name || !orgId) { res.status(400).json({ error: "name and organizationId required" }); return; }
    const [group] = await db.insert(userGroupsTable).values({ name, organizationId: orgId }).returning();
    await logAdminEvent({
      req, action: "group.create", resourceType: "user_group", resourceId: group.id,
      statusCode: 201, diff: { name: { to: group.name } },
    });
    res.status(201).json(group);
  } catch (err) { handleError(res, err); }
});

router.put("/user-groups/:id", requireRole("admin"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const { name } = req.body;
    const [existing] = await db.select().from(userGroupsTable)
      .where(and(eq(userGroupsTable.id, id), eq(userGroupsTable.organizationId, orgId)));
    if (!existing) { res.status(404).json({ error: "Group not found" }); return; }
    const [group] = await db.update(userGroupsTable).set({ name }).where(and(eq(userGroupsTable.id, id), eq(userGroupsTable.organizationId, orgId))).returning();
    await logAdminEvent({
      req, action: "group.update", resourceType: "user_group", resourceId: id,
      statusCode: 200, diff: { name: { from: existing.name, to: group.name } },
    });
    res.json(group);
  } catch (err) { handleError(res, err); }
});

router.delete("/user-groups/:id", requireRole("admin"), async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    await db.update(usersTable).set({ groupId: null }).where(and(eq(usersTable.groupId, id), eq(usersTable.organizationId, orgId)));
    const [deleted] = await db.delete(userGroupsTable).where(and(eq(userGroupsTable.id, id), eq(userGroupsTable.organizationId, orgId))).returning();
    if (!deleted) { res.status(404).json({ error: "Group not found" }); return; }
    await logAdminEvent({
      req, action: "group.delete", resourceType: "user_group", resourceId: id,
      statusCode: 204, diff: { name: { from: deleted.name } },
    });
    res.status(204).send();
  } catch (err) { handleError(res, err); }
});

export default router;
