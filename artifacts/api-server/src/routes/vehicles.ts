import { Router, type IRouter } from "express";
import { CreateVehicleBody, UpdateVehicleBody, ListVehiclesQueryParams, ReorderVehiclesBody } from "@workspace/api-zod";
import { handleError, parseUuidParam } from "../lib/errors";
import { assertOrgScope, getOrgId } from "../middleware/auth";
import * as vehicleService from "../services/vehicle-service";
import { geocodeAddress } from "../services/geocoding";

const router: IRouter = Router();

router.get("/vehicles", async (req, res) => {
  try {
    const { organizationId } = ListVehiclesQueryParams.parse(req.query);
    const orgId = assertOrgScope(req, organizationId);
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
    data.organizationId = assertOrgScope(req, data.organizationId);
    const { driverName, driver, ...vehicleData } = data;
    const driverInput = driver ?? (driverName ? { name: driverName } : undefined);
    if (driverInput?.startAddress) {
      const result = await geocodeAddress(driverInput.startAddress);
      if (!result) {
        res.status(400).json({ error: "Chaufförens startplats kunde inte verifieras" });
        return;
      }
      driverInput.startAddress = result.displayName;
      driverInput.startLatitude = result.latitude;
      driverInput.startLongitude = result.longitude;
    } else if (driverInput && (driverInput.startLatitude != null || driverInput.startLongitude != null)) {
      res.status(400).json({ error: "Startkoordinater kräver en verifierad adress" });
      return;
    }
    if (driverInput?.endAddress) {
      const result = await geocodeAddress(driverInput.endAddress);
      if (!result) {
        res.status(400).json({ error: "Chaufförens slutplats kunde inte verifieras" });
        return;
      }
      driverInput.endAddress = result.displayName;
      driverInput.endLatitude = result.latitude;
      driverInput.endLongitude = result.longitude;
    } else if (driverInput && (driverInput.endLatitude != null || driverInput.endLongitude != null)) {
      res.status(400).json({ error: "Slutkoordinater kräver en verifierad adress" });
      return;
    }
    const vehicle = await vehicleService.createVehicle(vehicleData, driverInput);
    res.status(201).json(vehicle);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/vehicles/reorder", async (req, res) => {
  try {
    const { vehicleIds } = ReorderVehiclesBody.parse(req.body);
    const vehicles = await vehicleService.reorderVehicles(vehicleIds, getOrgId(req));
    res.json(vehicles);
  } catch (err) {
    handleError(res, err);
  }
});

router.put("/vehicles/:id", async (req, res) => {
  try {
    const { id } = parseUuidParam(req.params);
    const data = UpdateVehicleBody.parse(req.body);
    const orgId = getOrgId(req);
    const current = await vehicleService.getVehicle(id, orgId);
    if (!current) {
      res.status(404).json({ error: "Resource not found" });
      return;
    }
    if (data.driver) {
      for (const endpoint of ["start", "end"] as const) {
        const addressKey = `${endpoint}Address` as const;
        const latitudeKey = `${endpoint}Latitude` as const;
        const longitudeKey = `${endpoint}Longitude` as const;
        const address = data.driver[addressKey];
        if (address === undefined) {
          if (data.driver[latitudeKey] !== undefined || data.driver[longitudeKey] !== undefined) {
            res.status(400).json({ error: "Koordinater kräver en verifierad adress" });
            return;
          }
          continue;
        }
        if (!address?.trim()) {
          data.driver[addressKey] = null;
          data.driver[latitudeKey] = null;
          data.driver[longitudeKey] = null;
          continue;
        }
        const saved = current.resourceProfile;
        const unchanged = address === saved?.[addressKey] && saved?.[latitudeKey] != null && saved?.[longitudeKey] != null;
        const verified = unchanged ? {
          displayName: saved![addressKey]!, latitude: saved![latitudeKey]!, longitude: saved![longitudeKey]!,
        } : await geocodeAddress(address);
        if (!verified) {
          res.status(400).json({ error: "Resursens start- eller slutplats kunde inte verifieras" });
          return;
        }
        data.driver[addressKey] = verified.displayName;
        data.driver[latitudeKey] = verified.latitude;
        data.driver[longitudeKey] = verified.longitude;
      }
    }
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
