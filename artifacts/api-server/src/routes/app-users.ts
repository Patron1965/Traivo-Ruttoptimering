import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, usersTable, userGroupsTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { getOrgId } from "../middleware/auth";

const router: IRouter = Router();

router.get("/app-users", async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const users = await db.select({
      id: usersTable.id,
      organizationId: usersTable.organizationId,
      name: usersTable.name,
      email: usersTable.email,
      role: usersTable.role,
      groupId: usersTable.groupId,
      createdAt: usersTable.createdAt,
      groupName: userGroupsTable.name,
    }).from(usersTable)
      .leftJoin(userGroupsTable, eq(usersTable.groupId, userGroupsTable.id))
      .where(eq(usersTable.organizationId, orgId));
    res.json(users);
  } catch (err) { handleError(res, err); }
});

router.post("/app-users", async (req, res) => {
  try {
    const orgId = req.user?.organizationId ?? req.body.organizationId;
    const { name, email, role, groupId } = req.body;
    if (!name || !email || !orgId) { res.status(400).json({ error: "name, email, and organizationId required" }); return; }
    const [user] = await db.insert(usersTable).values({ name, email, role: role || "dispatcher", groupId, organizationId: orgId }).returning();
    res.status(201).json(user);
  } catch (err) { handleError(res, err); }
});

router.put("/app-users/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const updates: Record<string, unknown> = {};
    if (req.body.name !== undefined) updates.name = req.body.name;
    if (req.body.email !== undefined) updates.email = req.body.email;
    if (req.body.role !== undefined) updates.role = req.body.role;
    if (req.body.groupId !== undefined) updates.groupId = req.body.groupId;
    const [user] = await db.update(usersTable).set(updates as any).where(and(eq(usersTable.id, id), eq(usersTable.organizationId, orgId))).returning();
    if (!user) { res.status(404).json({ error: "User not found" }); return; }
    res.json(user);
  } catch (err) { handleError(res, err); }
});

router.delete("/app-users/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const [deleted] = await db.delete(usersTable).where(and(eq(usersTable.id, id), eq(usersTable.organizationId, orgId))).returning();
    if (!deleted) { res.status(404).json({ error: "User not found" }); return; }
    res.status(204).send();
  } catch (err) { handleError(res, err); }
});

export default router;
