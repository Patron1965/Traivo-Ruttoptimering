import { Router, type IRouter } from "express";
import { eq } from "drizzle-orm";
import { db, vehiclesTable } from "@workspace/db";
import {
  CreateVehicleBody,
  UpdateVehicleBody,
  ListVehiclesQueryParams,
} from "@workspace/api-zod";
import { handleError, parseUuidParam } from "../lib/errors";

const router: IRouter = Router();

router.get("/vehicles", async (req, res) => {
  try {
    const { organizationId } = ListVehiclesQueryParams.parse(req.query);
    const vehicles = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.organizationId, organizationId));
    res.json(vehicles);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/vehicles/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const [vehicle] = await db
      .select()
      .from(vehiclesTable)
      .where(eq(vehiclesTable.id, id));
    if (!vehicle) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    res.json(vehicle);
  } catch (err) {
    handleError(res, err);
  }
});

router.post("/vehicles", async (req, res) => {
  try {
    const data = CreateVehicleBody.parse(req.body);
    const [vehicle] = await db.insert(vehiclesTable).values(data).returning();
    res.status(201).json(vehicle);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/vehicles/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const data = UpdateVehicleBody.parse(req.body);
    const [vehicle] = await db
      .update(vehiclesTable)
      .set(data)
      .where(eq(vehiclesTable.id, id))
      .returning();
    if (!vehicle) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    res.json(vehicle);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/vehicles/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const [deleted] = await db
      .delete(vehiclesTable)
      .where(eq(vehiclesTable.id, id))
      .returning();
    if (!deleted) {
      res.status(404).json({ error: "Vehicle not found" });
      return;
    }
    res.status(204).send();
  } catch (err) {
    handleError(res, err);
  }
});

export default router;
