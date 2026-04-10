import { Router, type IRouter } from "express";
import { eq, and, sql } from "drizzle-orm";
import { db, userGroupsTable, usersTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { getOrgId } from "../middleware/auth";

const router: IRouter = Router();

router.get("/user-groups", async (req, res) => {
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

router.post("/user-groups", async (req, res) => {
  try {
    const orgId = req.user?.organizationId ?? req.body.organizationId;
    const { name } = req.body;
    if (!name || !orgId) { res.status(400).json({ error: "name and organizationId required" }); return; }
    const [group] = await db.insert(userGroupsTable).values({ name, organizationId: orgId }).returning();
    res.status(201).json(group);
  } catch (err) { handleError(res, err); }
});

router.put("/user-groups/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const { name } = req.body;
    const [group] = await db.update(userGroupsTable).set({ name }).where(and(eq(userGroupsTable.id, id), eq(userGroupsTable.organizationId, orgId))).returning();
    if (!group) { res.status(404).json({ error: "Group not found" }); return; }
    res.json(group);
  } catch (err) { handleError(res, err); }
});

router.delete("/user-groups/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    await db.update(usersTable).set({ groupId: null }).where(and(eq(usersTable.groupId, id), eq(usersTable.organizationId, orgId)));
    const [deleted] = await db.delete(userGroupsTable).where(and(eq(userGroupsTable.id, id), eq(userGroupsTable.organizationId, orgId))).returning();
    if (!deleted) { res.status(404).json({ error: "Group not found" }); return; }
    res.status(204).send();
  } catch (err) { handleError(res, err); }
});

export default router;
