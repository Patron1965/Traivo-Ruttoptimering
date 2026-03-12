import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, vehiclesTable } from "@workspace/db";
import {
  CreateVehicleBody,
  UpdateVehicleBody,
  ListVehiclesQueryParams,
} from "@workspace/api-zod";

const router: IRouter = Router();

router.get("/vehicles", async (req, res) => {
  try {
    const { organizationId } = ListVehiclesQueryParams.parse(req.query);
    const vehicles = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.organizationId, organizationId));
    res.json(vehicles);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.get("/vehicles/:id", async (req, res) => {
  try {
    const [vehicle] = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, req.params.id));
    if (!vehicle) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    res.json(vehicle);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.post("/vehicles", async (req, res) => {
  try {
    const data = CreateVehicleBody.parse(req.body);
    const [vehicle] = await db.insert(vehiclesTable).values(data).returning();
    res.status(201).json(vehicle);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.put("/vehicles/:id", async (req, res) => {
  try {
    const data = UpdateVehicleBody.parse(req.body);
    const [vehicle] = await db
      .update(vehiclesTable)
      .set(data)
      .where(eq(vehiclesTable.id, req.params.id))
      .returning();
    if (!vehicle) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    res.json(vehicle);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

router.delete("/vehicles/:id", async (req, res) => {
  try {
    const [deleted] = await db
      .delete(vehiclesTable)
      .where(eq(vehiclesTable.id, req.params.id))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    res.status(204).send();
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

export default router;
