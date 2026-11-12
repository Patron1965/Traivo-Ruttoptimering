import { Router, type IRouter } from "express";
import { and, eq, inArray } from "drizzle-orm";
import { db, vehiclesTable, driversTable } from "@workspace/db";
import { handleError } from "../lib/errors";
import { outgoingRoutesForDriver, outgoingStopContext, outgoingStops } from "../services/outgoing-route-service";
import { projectStopForReadRole } from "../services/stop-service";

/**
 * Operational driver reads are intentionally not planner aggregate reads.
 * Intercept canonical app reads before generic planning routers; admin planning
 * responses remain untouched. Authorization is still session/tenant scoped.
 */
export const outgoingDriverReads: IRouter = Router();
outgoingDriverReads.use(async (req, res, next) => {
  if (req.user?.role !== "driver" || req.method !== "GET") { next(); return; }
  const principal = req.user;
  if (!principal.driverProfileId) { res.status(403).json({ error: "Driver profile required" }); return; }
  const path = req.path;
  try {
    const scopedDriver = path.match(/^\/drivers\/([0-9a-f-]{36})\/(?:preferences|stats)/i);
    if (scopedDriver && scopedDriver[1] !== principal.driverProfileId) {
      res.status(404).json({ error: "Driver not found" }); return;
    }
    if (/^\/stops\/?$/.test(path)) {
      const routes = await outgoingRoutesForDriver(principal.organizationId, principal.driverProfileId);
      const requestedRoute = typeof req.query.routeId === "string" ? req.query.routeId : null;
      const stops = (await Promise.all(routes.filter((route) => !requestedRoute || route.id === requestedRoute)
        .map((route) => outgoingStops(route)))).flat();
      res.json(stops.map((stop) => projectStopForReadRole(stop, "driver"))); return;
    }
    const stopMatch = path.match(/^\/stops\/([0-9a-f-]{36})\/?$/i);
    if (stopMatch) {
      const { stop } = await outgoingStopContext(principal.organizationId, stopMatch[1]!, principal.driverProfileId);
      res.json(projectStopForReadRole(stop, "driver")); return;
    }
    const vehicleMatch = path.match(/^\/vehicles(?:\/([0-9a-f-]{36}))?\/?$/i);
    if (vehicleMatch) {
      const routes = await outgoingRoutesForDriver(principal.organizationId, principal.driverProfileId);
      const ids = [...new Set(routes.flatMap((route) => route.vehicleId ? [route.vehicleId] : []))];
      const rows = ids.length ? await db.select().from(vehiclesTable).where(and(
        eq(vehiclesTable.organizationId, principal.organizationId), inArray(vehiclesTable.id, ids),
      )) : [];
      const approved = rows.map((vehicle) => {
        const route = routes.find((candidate) => candidate.vehicleId === vehicle.id);
        const captured = (route as any)?.__vehicle;
        return captured ? { ...captured, currentBatteryPercent: vehicle.currentBatteryPercent } : {
          id: vehicle.id, organizationId: vehicle.organizationId,
        };
      });
      if (vehicleMatch[1]) {
        const vehicle = approved.find((candidate) => candidate.id === vehicleMatch[1]);
        if (!vehicle) { res.status(404).json({ error: "Vehicle not found" }); return; }
        res.json(vehicle); return;
      }
      res.json(approved); return;
    }
    const driverMatch = path.match(/^\/drivers(?:\/([0-9a-f-]{36}))?\/?$/i);
    if (driverMatch) {
      if (driverMatch[1] && driverMatch[1] !== principal.driverProfileId) {
        res.status(404).json({ error: "Driver not found" }); return;
      }
      const [driver] = await db.select().from(driversTable).where(and(
        eq(driversTable.id, principal.driverProfileId), eq(driversTable.organizationId, principal.organizationId),
      ));
      if (!driver) { res.status(404).json({ error: "Driver not found" }); return; }
      const routes = await outgoingRoutesForDriver(principal.organizationId, principal.driverProfileId);
      const newest = routes.sort((a, b) => (b.sentAt?.getTime() ?? 0) - (a.sentAt?.getTime() ?? 0))[0];
      const projected = { ...driver, vehicleId: newest?.vehicleId ?? null };
      res.json(driverMatch[1] ? projected : [projected]); return;
    }
    // Other operational reads have their own ownership middleware. Do not let
    // drivers read planner aggregates/drafts/import previews containing new work.
    const operational = [
      /^\/auth\//, /^\/routes(?:\/[0-9a-f-]{36}(?:\/(?:stops|dispatch-snapshot|execution|incidents|messages))?)?\/?$/i,
      /^\/stops\/[0-9a-f-]{36}\/(?:proofs?|service-report|exceptions|messages|execution-events)/i,
      /^\/drivers\/[0-9a-f-]{36}\/(?:preferences|stats)/i,
      /^\/tracking\//, /^\/vehicles\/positions\/?$/, /^\/geofence\/events\/?$/, /^\/notifications(?:\/|$)/,
      /^\/org-settings\/?$/, /^\/org\/report-categories\/?$/, /^\/storage\//, /^\/osrm\//, /^\/branding\//,
    ].some((pattern) => pattern.test(path));
    if (!operational) { res.status(403).json({ error: "Planner data is not available in driver scope" }); return; }
    next();
  } catch (error) { handleError(res, error); }
});
