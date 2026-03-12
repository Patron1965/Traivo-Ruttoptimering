import { Router, type IRouter } from "express";
import { eq, and } from "drizzle-orm";
import { db, driversTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";

const router: IRouter = Router();

router.get("/drivers", async (req, res) => {
  try {
    const organizationId = req.query.organizationId as string;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const drivers = await db
      .select()
      .from(driversTable)
      .where(eq(driversTable.organizationId, organizationId));
    res.json(drivers);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/drivers/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.query.organizationId as string;
    const conditions = organizationId
      ? and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId))
      : eq(driversTable.id, id);
    const [driver] = await db
      .select()
      .from(driversTable)
      .where(conditions);
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    res.json(driver);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/drivers", async (req, res) => {
  try {
    const { name, phone, email, vehicleId, organizationId } = req.body;
    if (!name || !organizationId) {
      res.status(400).json({ error: "name and organizationId are required" });
      return;
    }
    const [driver] = await db
      .insert(driversTable)
      .values({ name, phone, email, vehicleId, organizationId })
      .returning();
    res.status(201).json(driver);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/drivers/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const { name, phone, email, vehicleId, isActive } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (vehicleId !== undefined) updates.vehicleId = vehicleId;
    if (isActive !== undefined) updates.isActive = isActive;

    const organizationId = req.query.organizationId as string;
    const conditions = organizationId
      ? and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId))
      : eq(driversTable.id, id);
    const [driver] = await db
      .update(driversTable)
      .set(updates)
      .where(conditions)
      .returning();
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    res.json(driver);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/drivers/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.query.organizationId as string;
    const conditions = organizationId
      ? and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId))
      : eq(driversTable.id, id);
    const [deleted] = await db
      .delete(driversTable)
      .where(conditions)
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
