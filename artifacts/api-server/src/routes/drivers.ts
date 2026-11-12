import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, routesTable, vehiclesTable } from "@workspace/db";
import { handleError, parseUuidParam } from "../lib/errors";
import { getOrgId, requireRole } from "../middleware/auth";
import * as driverService from "../services/driver-service";
import { outgoingRoute, OutgoingVersionError } from "../services/outgoing-route-service";
import { geocodeAddress, normalizeGeocodeInput } from "../services/geocoding";
import {
  DriverAssistanceError,
  getDriverAssistanceContext,
  validateDriverAssistanceContext,
} from "../lib/driver-assistance";

const router: IRouter = Router();

/**
 * Provider display names are not stable formatting. Compare the normalized
 * address evidence before re-verifying an existing endpoint so a harmless
 * punctuation/country/unit representation change cannot discard its stored
 * coordinates. A genuinely changed address still goes through the provider.
 */
function sameVerifiedAddress(left: string | null | undefined, right: string | null | undefined): boolean {
  const addressKey = (value: string | null | undefined) => normalizeGeocodeInput(value ?? "")
    .replace(/,\s*(sweden|sverige)$/iu, "")
    .toLocaleLowerCase("sv-SE");
  return addressKey(left) === addressKey(right);
}

/**
 * Purpose-built selector for the mobile assistance mode.  It intentionally
 * exposes only routes with a real current handoff recipient; an admin cannot
 * select an arbitrary driver and then use driver-action APIs against it.
 */
router.get("/driver-assistance", requireRole("admin"), async (req, res) => {
  try {
    const organizationId = getOrgId(req);
    const routes = await db
      .select()
      .from(routesTable)
      .where(and(
        eq(routesTable.organizationId, organizationId),
        inArray(routesTable.status, ["in_progress", "optimized"]),
        eq(routesTable.handoffVersion, routesTable.planRevision),
      ));
    const drivers = await driverService.listDrivers(organizationId);
    const resources = await db.select({ id: vehiclesTable.id, name: vehiclesTable.name })
      .from(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    const resourceNames = new Map(resources.map((resource) => [resource.id, resource.name]));
    const names = new Map(drivers.map((driver) => [driver.id, driver]));
    const assignments = [];
    for (const route of routes) {
      const driver = route.handoffDriverId ? names.get(route.handoffDriverId) : null;
      if (!driver?.isActive) continue;
      try {
        // Match the authoritative read guard; a legacy handoff flag alone
        // is not evidence that this assignment can be opened.
        const projected = await outgoingRoute(route);
        if (projected.status === "completed" || projected.status === "cancelled") continue;
        assignments.push({
          driver: { ...driver, name: projected.vehicleId ? resourceNames.get(projected.vehicleId) ?? driver.name : driver.name },
          route: {
            id: projected.id, name: projected.name, status: projected.status,
            organizationId, handoffDriverId: projected.handoffDriverId,
            vehicleId: projected.vehicleId, date: projected.date,
            handoffStatus: projected.handoffStatus, handoffVersion: projected.handoffVersion,
            planRevision: projected.planRevision,
          },
        });
      } catch (error) {
        if (!(error instanceof OutgoingVersionError)) throw error;
        // Invalid legacy assignments need planner review, never reconstructed evidence.
      }
    }
    res.json(assignments);
  } catch (err) {
    handleError(res, err);
  }
});

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
    await validateDriverAssistanceContext(req, { driverId: id });
    const orgId = getOrgId(req);
    const driver = await driverService.getDriver(id, orgId);
    if (!driver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    res.json(driver);
  } catch (err) {
    if (err instanceof DriverAssistanceError) {
      res.status(err.statusCode).json({ error: err.message });
      return;
    }
    handleError(res, err);
  }
});

router.post("/drivers", async (req, res) => {
  try {
    const { name, phone, email, vehicleId, organizationId, isActive,
      workStartTime, workEndTime, tempo, capacityKg, capacityVolume,
      breakStartTime, breakEndTime, startAddress, startLatitude, startLongitude,
      endAddress, endLatitude, endLongitude, driverRole, skills } = req.body;
    const orgId = req.user?.organizationId ?? organizationId;
    if (!name || !orgId) {
      res.status(400).json({ error: "name and organizationId are required" });
      return;
    }
    if ((capacityKg != null && capacityKg < 0) || (capacityVolume != null && capacityVolume < 0)) {
      res.status(400).json({ error: "Chaufförens kapacitet får inte vara negativ" });
      return;
    }
    if (!startAddress?.trim() && (startLatitude != null || startLongitude != null)) {
      res.status(400).json({ error: "Startkoordinater kräver en verifierad adress" });
      return;
    }
    if (!endAddress?.trim() && (endLatitude != null || endLongitude != null)) {
      res.status(400).json({ error: "Slutkoordinater kräver en verifierad adress" });
      return;
    }
    const verifiedStart = startAddress?.trim() ? await geocodeAddress(startAddress) : null;
    if (startAddress?.trim() && !verifiedStart) {
      res.status(400).json({ error: "Chaufförens startplats kunde inte verifieras" });
      return;
    }
    const verifiedEnd = endAddress?.trim() ? await geocodeAddress(endAddress) : null;
    if (endAddress?.trim() && !verifiedEnd) {
      res.status(400).json({ error: "Chaufförens slutplats kunde inte verifieras" });
      return;
    }
    const result = await driverService.createDriver({
      name, phone, email, vehicleId, organizationId: orgId, isActive,
      workStartTime, workEndTime, tempo, capacityKg, capacityVolume,
      breakStartTime, breakEndTime,
      startAddress: verifiedStart?.displayName ?? null,
      startLatitude: verifiedStart?.latitude ?? null,
      startLongitude: verifiedStart?.longitude ?? null,
      endAddress: verifiedEnd?.displayName ?? null,
      endLatitude: verifiedEnd?.latitude ?? null,
      endLongitude: verifiedEnd?.longitude ?? null,
      driverRole, skills
    });
    if ("error" in result && typeof result.status === "number") {
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
    if (getDriverAssistanceContext(req)) {
      res.status(403).json({
        error: "Driver profile and push-token changes are not available during live assistance",
      });
      return;
    }
    const orgId = getOrgId(req);
    const currentDriver = await driverService.getDriver(id, orgId);
    if (!currentDriver) {
      res.status(404).json({ error: "Driver not found" });
      return;
    }
    const { name, phone, email, vehicleId, isActive,
      workStartTime, workEndTime, tempo, capacityKg, capacityVolume,
      breakStartTime, breakEndTime,
      startAddress, startLatitude, startLongitude, endAddress, endLatitude, endLongitude,
      expoPushToken, driverRole, skills } = req.body;
    const updates: Record<string, unknown> = {};
    if ((capacityKg != null && capacityKg < 0) || (capacityVolume != null && capacityVolume < 0)) {
      res.status(400).json({ error: "Chaufförens kapacitet får inte vara negativ" });
      return;
    }
    if (name !== undefined) updates.name = name;
    if (phone !== undefined) updates.phone = phone;
    if (email !== undefined) updates.email = email;
    if (vehicleId !== undefined) updates.vehicleId = vehicleId;
    if (isActive !== undefined) updates.isActive = isActive;
    if (workStartTime !== undefined) updates.workStartTime = workStartTime;
    if (workEndTime !== undefined) updates.workEndTime = workEndTime;
    if (breakStartTime !== undefined) updates.breakStartTime = breakStartTime;
    if (breakEndTime !== undefined) updates.breakEndTime = breakEndTime;
    if (tempo !== undefined) updates.tempo = tempo;
    if (capacityKg !== undefined) updates.capacityKg = capacityKg;
    if (capacityVolume !== undefined) updates.capacityVolume = capacityVolume;
    if (startAddress !== undefined) {
      const normalizedStartAddress = startAddress?.trim() || null;
      if (!sameVerifiedAddress(normalizedStartAddress, currentDriver.startAddress)) {
        const verified = normalizedStartAddress ? await geocodeAddress(normalizedStartAddress) : null;
        if (normalizedStartAddress && !verified) {
          res.status(400).json({ error: "Chaufförens startplats kunde inte verifieras" });
          return;
        }
        updates.startAddress = verified?.displayName ?? null;
        updates.startLatitude = verified?.latitude ?? null;
        updates.startLongitude = verified?.longitude ?? null;
      }
    } else if (startLatitude !== undefined || startLongitude !== undefined) {
      res.status(400).json({ error: "Startkoordinater kan bara ändras genom en verifierad adress" });
      return;
    }
    if (endAddress !== undefined) {
      const normalizedEndAddress = endAddress?.trim() || null;
      if (!sameVerifiedAddress(normalizedEndAddress, currentDriver.endAddress)) {
        const verified = normalizedEndAddress ? await geocodeAddress(normalizedEndAddress) : null;
        if (normalizedEndAddress && !verified) {
          res.status(400).json({ error: "Chaufförens slutplats kunde inte verifieras" });
          return;
        }
        updates.endAddress = verified?.displayName ?? null;
        updates.endLatitude = verified?.latitude ?? null;
        updates.endLongitude = verified?.longitude ?? null;
      }
    } else if (endLatitude !== undefined || endLongitude !== undefined) {
      res.status(400).json({ error: "Slutkoordinater kan bara ändras genom en verifierad adress" });
      return;
    }
    if (expoPushToken !== undefined) updates.expoPushToken = expoPushToken;
    if (driverRole !== undefined) updates.driverRole = driverRole;
    if (skills !== undefined) updates.skills = skills;

    const result = await driverService.updateDriver(id, orgId, updates);
    if ("error" in result && typeof result.status === "number") {
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
