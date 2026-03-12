import { Router, type IRouter } from "express";
import { eq, and, ne } from "drizzle-orm";
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
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const [driver] = await db
      .select()
      .from(driversTable)
      .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId)));
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
    const { name, phone, email, vehicleId, organizationId, isActive } = req.body;
    if (!name || !organizationId) {
      res.status(400).json({ error: "name and organizationId are required" });
      return;
    }

    if (vehicleId) {
      const [existing] = await db
        .select()
        .from(driversTable)
        .where(
          and(
            eq(driversTable.vehicleId, vehicleId),
            eq(driversTable.isActive, true),
            eq(driversTable.organizationId, organizationId)
          )
        )
        .limit(1);
      if (existing) {
        res.status(409).json({ error: `Vehicle is already assigned to driver ${existing.name}` });
        return;
      }
    }

    const [driver] = await db
      .insert(driversTable)
      .values({ name, phone, email, vehicleId, organizationId, isActive: isActive ?? true })
      .returning();
    res.status(201).json(driver);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/drivers/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const organizationId = req.query.organizationId as string;
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const { name, phone, email, vehicleId, isActive } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (vehicleId !== undefined) updates.vehicleId = vehicleId;
    if (isActive !== undefined) updates.isActive = isActive;

    const [currentDriver] = await db
      .select()
      .from(driversTable)
      .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId)));
    if (!currentDriver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }

    const effectiveVehicleId = vehicleId !== undefined ? vehicleId : currentDriver.vehicleId;
    const effectiveIsActive = isActive !== undefined ? isActive : currentDriver.isActive;

    if (effectiveVehicleId && effectiveIsActive) {
      const [existing] = await db
        .select()
        .from(driversTable)
        .where(
          and(
            eq(driversTable.vehicleId, effectiveVehicleId),
            eq(driversTable.isActive, true),
            eq(driversTable.organizationId, organizationId),
            ne(driversTable.id, id)
          )
        )
        .limit(1);
      if (existing) {
        res.status(409).json({ error: `Vehicle is already assigned to driver ${existing.name}` });
        return;
      }
    }

    const [driver] = await db
      .update(driversTable)
      .set(updates)
      .where(eq(driversTable.id, id))
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
    if (!organizationId) {
      res.status(400).json({ error: "organizationId is required" });
      return;
    }
    const [deleted] = await db
      .delete(driversTable)
      .where(and(eq(driversTable.id, id), eq(driversTable.organizationId, organizationId)))
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
