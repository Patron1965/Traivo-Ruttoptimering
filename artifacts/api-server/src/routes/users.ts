import { Router, type IRouter } from "express";
import { and, eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

// Explicit safe projection — never expose passwordHash or lockout metadata.
const publicUserColumns = {
  id: usersTable.id,
  organizationId: usersTable.organizationId,
  name: usersTable.name,
  email: usersTable.email,
  role: usersTable.role,
  driverProfileId: usersTable.driverProfileId,
  groupId: usersTable.groupId,
  lastLoginAt: usersTable.lastLoginAt,
  createdAt: usersTable.createdAt,
};

router.get("/users", async (req, res) => {
  try {
    const organizationId = req.user!.organizationId;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const users = await db
      .select(publicUserColumns)
      .from(usersTable)
      .where(eq(usersTable.organizationId, organizationId));
    res.json(users);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/users/:id", async (req, res) => {
  try {
    const [user] = await db
      .select(publicUserColumns)
      .from(usersTable)
      .where(
        and(
          eq(usersTable.id, req.params.id),
          eq(usersTable.organizationId, req.user!.organizationId),
        ),
      );
    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }
    res.json(user);
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
