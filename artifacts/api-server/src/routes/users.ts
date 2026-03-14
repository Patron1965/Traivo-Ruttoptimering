import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, usersTable } from "@workspace/db";
import { handleError } from "../lib/errors";

const router: IRouter = Router();

router.get("/users", async (req, res) => {
  try {
    const organizationId = req.query.organizationId as string;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const users = await db
      .select()
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
      .select()
      .from(usersTable)
      .where(eq(usersTable.id, req.params.id));
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
