import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import test from "node:test";
import express, { type Express } from "express";
import { eq } from "drizzle-orm";
import JSZip from "jszip";
import {
  auditLogTable,
  db,
  driversTable,
  organizationsTable,
  routesTable,
  stopsTable,
  vehiclesTable,
} from "@workspace/db";
import type { AuthUser, UserRole } from "../middleware/auth";
import exportRouter from "./export";

function appFor(organizationId: string, role: UserRole): Express {
  const app = express();
  app.use((req, _res, next) => {
    req.user = {
      id: randomUUID(),
      name: "Route export test",
      email: "route-export@example.test",
      role,
      organizationId,
      driverProfileId: null,
    } satisfies AuthUser;
    next();
  });
  app.use(exportRouter);
  return app;
}

async function get(app: Express, path: string) {
  const server = app.listen(0);
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  try {
    const response = await fetch(`http://127.0.0.1:${port}${path}`);
    return {
      status: response.status,
      contentType: response.headers.get("content-type"),
      body: Buffer.from(await response.arrayBuffer()),
    };
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => error ? reject(error) : resolve()));
  }
}

test("route-plan XLSX includes only the selected tenant and plan, and rejects viewers", async () => {
  const organizationId = randomUUID();
  const foreignOrganizationId = randomUUID();
  const planId = randomUUID();
  const allUnplannedPlanId = randomUUID();
  const unrelatedPlanId = randomUUID();
  const routeId = randomUUID();
  const vehicleId = randomUUID();
  const planningDate = new Date("2026-09-07T08:00:00.000Z");
  await db.insert(organizationsTable).values([
    { id: organizationId, name: "Export tenant", email: `${organizationId}@example.test` },
    { id: foreignOrganizationId, name: "Foreign export tenant", email: `${foreignOrganizationId}@example.test` },
  ]);
  try {
    await db.insert(vehiclesTable).values({
      id: vehicleId,
      organizationId,
      name: "Exportbil",
      licensePlate: "XLSX-001",
    });
    await db.insert(driversTable).values({
      id: randomUUID(),
      organizationId,
      vehicleId,
      name: "Exportförare",
    });
    await db.insert(routesTable).values({
      id: routeId,
      planId,
      organizationId,
      vehicleId,
      name: "Export-rutt",
      status: "optimized",
      date: planningDate,
      totalStops: 1,
      plannerItinerary: [{
        stopId: "00000000-0000-4000-8000-000000000001",
        sequenceOrder: 1,
        estimatedArrival: "2026-09-07T08:30:00.000Z",
        distanceFromPreviousKm: 4.2,
      }],
    });
    await db.insert(stopsTable).values([
      {
        id: "00000000-0000-4000-8000-000000000001",
        organizationId,
        routeId,
        planningPlanId: planId,
        planningDate,
        sourceRowNumber: 2,
        sequenceOrder: 1,
        externalRef: "OWN-PLANNED",
        address: "Planerad adress",
        latitude: 59.33,
        longitude: 18.07,
        customFields: {
          "Kundens zon": "Nord",
          "Källrad i importfil": "Kundens egen källrad",
        },
      },
      {
        id: randomUUID(),
        organizationId,
        planningPlanId: planId,
        planningDate,
        sourceRowNumber: 3,
        unplannedReason: "Kapaciteten räcker inte för detta stopp.",
        externalRef: "OWN-UNPLANNED",
        address: "Ej planerad adress",
        latitude: 59.34,
        longitude: 18.08,
      },
      {
        id: randomUUID(),
        organizationId,
        planningPlanId: unrelatedPlanId,
        planningDate,
        externalRef: "SAME-TENANT-OTHER-PLAN",
        address: "Annan plan",
        latitude: 59.35,
        longitude: 18.09,
      },
      {
        id: randomUUID(),
        organizationId,
        planningPlanId: allUnplannedPlanId,
        planningDate,
        sourceRowNumber: 4,
        unplannedReason: "Tidsfönstret kan inte uppfyllas.",
        externalRef: "ALL-UNPLANNED",
        address: "Helt oplanerad plan",
        latitude: 59.355,
        longitude: 18.095,
      },
      {
        id: randomUUID(),
        organizationId: foreignOrganizationId,
        planningPlanId: planId,
        planningDate,
        externalRef: "FOREIGN-TENANT",
        address: "Annan kund",
        latitude: 59.36,
        longitude: 18.1,
      },
    ]);

    const dispatcherResponse = await get(
      appFor(organizationId, "dispatcher"),
      `/export?type=routePlan&format=xlsx&planId=${planId}`,
    );
    assert.equal(dispatcherResponse.status, 200);
    assert.match(dispatcherResponse.contentType ?? "", /spreadsheetml\.sheet/);
    const zip = await JSZip.loadAsync(dispatcherResponse.body);
    const plannedXml = await zip.file("xl/worksheets/sheet2.xml")!.async("string");
    const unplannedXml = await zip.file("xl/worksheets/sheet3.xml")!.async("string");
    const allCustomerRows = `${plannedXml}${unplannedXml}`;
    for (const reference of ["OWN-PLANNED", "OWN-UNPLANNED"]) {
      assert.equal(allCustomerRows.split(reference).length - 1, 1);
    }
    assert.doesNotMatch(allCustomerRows, /SAME-TENANT-OTHER-PLAN|FOREIGN-TENANT/);
    assert.match(plannedXml, /Kundens zon/);
    assert.match(plannedXml, /Kundfält: Källrad i importfil/);
    assert.match(plannedXml, /Kundens egen källrad/);
    assert.match(unplannedXml, /Kapaciteten räcker inte för detta stopp/);

    const viewerResponse = await get(
      appFor(organizationId, "viewer"),
      `/export?type=routePlan&format=xlsx&planId=${planId}`,
    );
    assert.equal(viewerResponse.status, 403);

    const allUnplannedResponse = await get(
      appFor(organizationId, "dispatcher"),
      `/export?type=routePlan&format=xlsx&planId=${allUnplannedPlanId}`,
    );
    assert.equal(allUnplannedResponse.status, 200);
    const allUnplannedZip = await JSZip.loadAsync(allUnplannedResponse.body);
    const emptyRoutesXml = await allUnplannedZip.file("xl/worksheets/sheet1.xml")!.async("string");
    const allUnplannedXml = await allUnplannedZip.file("xl/worksheets/sheet3.xml")!.async("string");
    assert.doesNotMatch(emptyRoutesXml, /ALL-UNPLANNED/);
    assert.match(allUnplannedXml, /ALL-UNPLANNED/);
    assert.match(allUnplannedXml, /Tidsfönstret kan inte uppfyllas/);
  } finally {
    await db.delete(auditLogTable).where(eq(auditLogTable.organizationId, organizationId));
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, foreignOrganizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
    await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, foreignOrganizationId));
  }
});