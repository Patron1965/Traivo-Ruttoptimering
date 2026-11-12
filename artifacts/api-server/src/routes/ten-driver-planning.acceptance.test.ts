import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { test } from "node:test";
import express, { type Express } from "express";
import { asc, eq } from "drizzle-orm";
import {
  db,
  driversTable,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import type { AuthUser } from "../middleware/auth";
import importRouteWorkflowRouter from "./import-route-workflow";

const STOP_COUNT = 120;
const RESOURCE_COUNT = 10;
const PLAN_DATE = new Date("2026-10-15T06:00:00.000Z");
const DEPOT = { latitude: 59.3293, longitude: 18.0686 };

function appFor(organizationId: string): Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    req.user = {
      id: randomUUID(),
      name: "Acceptansförare",
      email: "acceptance@example.test",
      role: "dispatcher",
      organizationId,
      driverProfileId: null,
    } satisfies AuthUser;
    next();
  });
  app.use(importRouteWorkflowRouter);
  return app;
}

async function post(app: Express, path: string, body: unknown) {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() as any };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

function realisticStop(
  organizationId: string,
  id: string,
  sourceRowNumber: number,
) {
  const index = sourceRowNumber - 1;
  const cluster = index % RESOURCE_COUNT;
  const position = Math.floor(index / RESOURCE_COUNT);
  const angle = (cluster / RESOURCE_COUNT) * Math.PI * 2;
  const radius = 0.018 + position * 0.0007;
  const latitude = DEPOT.latitude + Math.cos(angle) * radius;
  const longitude = DEPOT.longitude + Math.sin(angle) * radius * 1.7;
  const pickupDelivery = index % 4 === 0;
  return {
    id,
    organizationId,
    sourceRowNumber,
    externalRef: `ACCEPTANS-${String(sourceRowNumber).padStart(3, "0")}`,
    address: `Kundadress ${sourceRowNumber}, Stockholm`,
    latitude,
    longitude,
    timeWindowStart: new Date("2026-10-15T06:30:00.000Z"),
    timeWindowEnd: new Date("2026-10-15T17:30:00.000Z"),
    serviceDurationMin: 4 + (index % 3),
    weightKg: 15 + (index % 5) * 5,
    volumeM3: 0.08 + (index % 4) * 0.03,
    status: "pending" as const,
    jobType: pickupDelivery ? "pickup_delivery" as const : "delivery" as const,
    ...(pickupDelivery ? {
      pickupAddress: `Leverantör ${sourceRowNumber}, Stockholm`,
      pickupLatitude: latitude - 0.002,
      pickupLongitude: longitude - 0.002,
    } : {}),
  };
}

test("acceptansbevis: 120 källrader planeras med tio förare utan radförlust", {
  timeout: 120_000,
}, async () => {
  const organizationId = randomUUID();
  const vehicleIds = Array.from({ length: RESOURCE_COUNT }, () => randomUUID());
  const driverIds = Array.from({ length: RESOURCE_COUNT }, () => randomUUID());
  const stopIds = Array.from({ length: STOP_COUNT }, () => randomUUID());
  const capacityBlockedId = stopIds[STOP_COUNT - 1];

  await db.insert(organizationsTable).values({
    id: organizationId,
    name: "Acceptansscenario tio förare",
    email: `${organizationId}@example.test`,
  });

  try {
    await db.insert(vehiclesTable).values(vehicleIds.map((id, index) => ({
      id,
      organizationId,
      name: `Acceptansbil ${index + 1}`,
      licensePlate: `ACC-${String(index + 1).padStart(2, "0")}-${id.slice(0, 4)}`,
      vehicleType: index === 0 ? "electric" as const : "fossil" as const,
      capacityKg: 900,
      capacityVolume: 8,
      currentBatteryPercent: index === 0 ? 90 : null,
      rangeKm: index === 0 ? 350 : null,
      isActive: true,
    })));
    await db.insert(driversTable).values(driverIds.map((id, index) => ({
      id,
      organizationId,
      vehicleId: vehicleIds[index],
      name: `Acceptanschaufför ${index + 1}`,
      workStartTime: "06:00:00",
      workEndTime: "18:00:00",
      breakStartTime: "11:30:00",
      breakEndTime: "12:00:00",
      startLatitude: DEPOT.latitude,
      startLongitude: DEPOT.longitude,
      endLatitude: DEPOT.latitude,
      endLongitude: DEPOT.longitude,
      isActive: true,
    })));

    const stopRows = stopIds.map((id, index) =>
      realisticStop(organizationId, id, index + 1));
    stopRows[STOP_COUNT - 1].weightKg = 5_000;
    stopRows[STOP_COUNT - 1].volumeM3 = 20;
    await db.insert(stopsTable).values(stopRows);

    const response = await post(appFor(organizationId), "/import/route-plans", {
      stopIds,
      pairs: vehicleIds.map((vehicleId, index) => ({
        vehicleId,
        driverId: driverIds[index],
      })),
      vehicleDistributionMode: "balance",
      optimizationWeights: {
        distanceWeight: 0.7,
        co2Weight: 0.1,
        etaPrecisionWeight: 0.1,
        driverHappinessWeight: 0.1,
        geographicCohesionWeight: 0,
      },
      date: PLAN_DATE.toISOString(),
      depotLatitude: DEPOT.latitude,
      depotLongitude: DEPOT.longitude,
    });
    assert.equal(response.status, 200, JSON.stringify(response.body));

    const savedStops = await db.select().from(stopsTable)
      .where(eq(stopsTable.organizationId, organizationId))
      .orderBy(asc(stopsTable.sourceRowNumber));
    const savedRoutes = await db.select().from(routesTable)
      .where(eq(routesTable.organizationId, organizationId));
    const assigned = savedStops.filter((stop) => stop.routeId != null);
    const blocked = savedStops.filter((stop) => stop.routeId == null);
    const usedDriverIds = new Set(response.body.routes.map((route: any) => route.driverId));
    const usedVehicleIds = new Set(response.body.routes.map((route: any) => route.vehicleId));
    const routeById = new Map(savedRoutes.map((route) => [route.id, route]));

    assert.equal(savedStops.length, STOP_COUNT);
    assert.deepEqual(savedStops.map((stop) => stop.sourceRowNumber),
      Array.from({ length: STOP_COUNT }, (_, index) => index + 1));
    assert.equal(new Set(savedStops.map((stop) => stop.id)).size, STOP_COUNT);
    assert.equal(assigned.length + blocked.length, STOP_COUNT);
    assert.equal(response.body.unassignedStopIds.length, blocked.length);
    assert.deepEqual(new Set(blocked.map((stop) => stop.id)),
      new Set(response.body.unassignedStopIds));
    assert.equal(response.body.diagnostics.length, blocked.length);
    assert.equal(response.body.routes.length, RESOURCE_COUNT);
    assert.deepEqual(usedDriverIds, new Set(driverIds));
    assert.deepEqual(usedVehicleIds, new Set(vehicleIds));

    const diagnosticByStopId = new Map<string, { code: string; detail: string }>(
      response.body.diagnostics.map(
        (diagnostic: any) => [diagnostic.stopId, diagnostic]),
    );
    assert.equal(diagnosticByStopId.get(capacityBlockedId)?.code, "CAPACITY_EXCEEDED");
    assert.match(diagnosticByStopId.get(capacityBlockedId)?.detail ?? "", /kapaciteten/i);
    assert.ok(blocked.every((stop) => stop.unplannedReason?.trim()));

    for (const routeResult of response.body.routes) {
      const route = routeById.get(routeResult.routeId);
      assert.ok(route);
      const routeStops = assigned.filter(
        (stop) => stop.routeId === routeResult.routeId);
      assert.equal(routeResult.stopCount, routeStops.length);
      assert.ok(routeResult.stopCount > 0);
      assert.ok(routeResult.totalDistanceKm > 0);
      assert.ok(routeResult.totalDurationMin > 0);
      assert.equal(routeResult.workdaySummary.overtimeMin, 0);
      assert.ok(routeResult.workdaySummary.marginMin >= 0);
      assert.ok(routeResult.workdayTimeline.some(
        (event: any) => event.type === "service"));
      assert.ok(routeStops.reduce(
        (sum, stop) => sum + Number(stop.weightKg ?? 0), 0) <= 900);
      assert.ok(routeStops.reduce(
        (sum, stop) => sum + Number(stop.volumeM3 ?? 0), 0) <= 8);

      for (const stop of routeStops) {
        const serviceEvents = routeResult.workdayTimeline.filter(
          (event: any) => event.type === "service" && event.stopId === stop.id);
        const deliveryEvent = serviceEvents.at(-1);
        assert.ok(deliveryEvent, `servicehändelse saknas för källrad ${stop.sourceRowNumber}`);
        const serviceStart = new Date(deliveryEvent.startAt).getTime();
        if (stop.timeWindowStart) {
          assert.ok(serviceStart >= stop.timeWindowStart.getTime(),
            `källrad ${stop.sourceRowNumber} börjar före tidsfönstret`);
        }
        if (stop.timeWindowEnd) {
          assert.ok(serviceStart <= stop.timeWindowEnd.getTime(),
            `källrad ${stop.sourceRowNumber} börjar efter tidsfönstret`);
        }
      }
    }

    const evRoute = response.body.routes.find(
      (route: any) => route.vehicleId === vehicleIds[0]);
    assert.ok(evRoute, "elfordonet ska användas i balansprofilen");
    assert.ok(evRoute.totalDistanceKm <= 350 * 0.9 * 0.95,
      "elfordonets rutt ska hålla sig inom säker effektiv räckvidd");

    const routeStopCounts = response.body.routes.map(
      (route: any) => route.stopCount as number);
    const evidence = {
      scenario: "ten-driver-planning-v1",
      planningDate: PLAN_DATE.toISOString(),
      distributionProfile: "balance",
      selectedDrivers: RESOURCE_COUNT,
      usedDrivers: usedDriverIds.size,
      selectedVehicles: RESOURCE_COUNT,
      usedVehicles: usedVehicleIds.size,
      sourceRows: STOP_COUNT,
      plannedStops: assigned.length,
      blockedStops: blocked.length,
      deliveries: stopRows.filter((stop) => stop.jobType === "delivery").length,
      pickupDeliveries: stopRows.filter(
        (stop) => stop.jobType === "pickup_delivery").length,
      electricVehicles: 1,
      totalDistanceKm: Number(response.body.routes.reduce(
        (sum: number, route: any) => sum + route.totalDistanceKm, 0).toFixed(2)),
      totalDrivingMinutes: Number(response.body.routes.reduce(
        (sum: number, route: any) => sum
          + route.workdaySummary.nonReturnDrivingMin
          + route.workdaySummary.returnMin, 0).toFixed(2)),
      totalWorkMinutes: Number(response.body.routes.reduce(
        (sum: number, route: any) => sum + route.totalDurationMin, 0).toFixed(2)),
      workloadStops: {
        minimum: Math.min(...routeStopCounts),
        maximum: Math.max(...routeStopCounts),
        perDriver: response.body.routes.map((route: any) => ({
          driverId: route.driverId,
          stops: route.stopCount,
          distanceKm: route.totalDistanceKm,
          drivingMinutes: Number((
            route.workdaySummary.nonReturnDrivingMin
            + route.workdaySummary.returnMin
          ).toFixed(2)),
          serviceMinutes: route.workdaySummary.serviceMin,
          workMinutes: route.totalDurationMin,
          marginMinutes: route.workdaySummary.marginMin,
        })),
      },
      blockedReasons: response.body.diagnostics.map((diagnostic: any) => ({
        sourceRowNumber: savedStops.find(
          (stop) => stop.id === diagnostic.stopId)?.sourceRowNumber,
        code: diagnostic.code,
        detail: diagnostic.detail,
      })),
      assertions: {
        everySelectedFeasibleResourceUsed: true,
        everySourceRowAccountedForExactlyOnce: true,
        timeWindowsAndWorkingHoursFeasible: true,
        capacityRespected: true,
        electricRangeSafe: true,
      },
    };
    console.log(`TEN_DRIVER_ACCEPTANCE_EVIDENCE ${JSON.stringify(evidence)}`);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
  }
});