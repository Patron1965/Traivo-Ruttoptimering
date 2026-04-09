import { Router, type IRouter } from "express";
import { CreateVehicleBody, UpdateVehicleBody, ListVehiclesQueryParams } from "@workspace/api-zod";
import { handleError, parseUuidParam } from "../lib/errors";
import { getOrgId } from "../middleware/auth";
import * as vehicleService from "../services/vehicle-service";

const router: IRouter = Router();

router.get("/vehicles", async (req, res) => {
  try {
    const { organizationId } = ListVehiclesQueryParams.parse(req.query);
    const orgId = req.user?.organizationId ?? organizationId;
    const vehicles = await vehicleService.listVehicles(orgId);
    res.json(vehicles);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/vehicles/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const vehicle = await vehicleService.getVehicle(id, orgId);
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
    if (req.user) {
      data.organizationId = req.user.organizationId;
    }
    const vehicle = await vehicleService.createVehicle(data);
    res.status(201).json(vehicle);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/vehicles/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const data = UpdateVehicleBody.parse(req.body);
    const orgId = getOrgId(req);
    const vehicle = await vehicleService.updateVehicle(id, orgId, data);
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
    const orgId = getOrgId(req);
    const deleted = await vehicleService.deleteVehicle(id, orgId);
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
