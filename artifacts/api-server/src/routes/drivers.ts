import { Router, type IRouter } from "express";
import { handleError, parseUuidParam } from "../lib/errors";
import { getOrgId } from "../middleware/auth";
import * as driverService from "../services/driver-service";

const router: IRouter = Router();

router.get("/drivers", async (req, res) => {
  try {
    const orgId = getOrgId(req);
    const drivers = await driverService.listDrivers(orgId);
    res.json(drivers);
  } catch (err) {
    handleError(res, err);
  }
});

router.get("/drivers/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const driver = await driverService.getDriver(id, orgId);
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
    const orgId = req.user?.organizationId ?? organizationId;
    if (!name || !orgId) {
      res.status(400).json({ error: "name and organizationId are required" });
      return;
    }
    const result = await driverService.createDriver({ name, phone, email, vehicleId, organizationId: orgId, isActive });
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.status(201).json(result.data);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/drivers/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const { name, phone, email, vehicleId, isActive } = req.body;
    const updates: Record<string, unknown> = {};
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (vehicleId !== undefined) updates.vehicleId = vehicleId;
    if (isActive !== undefined) updates.isActive = isActive;

    const result = await driverService.updateDriver(id, orgId, updates);
    if ("error" in result) {
      res.status(result.status).json({ error: result.error });
      return;
    }
    res.json(result.data);
  } catch (err) {
    handleError(res, err);
  }
});

router.delete("/drivers/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const orgId = getOrgId(req);
    const deleted = await driverService.deleteDriver(id, orgId);
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
