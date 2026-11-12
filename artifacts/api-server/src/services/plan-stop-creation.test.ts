import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { and, eq } from "drizzle-orm";
import { db, organizationsTable, routesTable, stopsTable } from "@workspace/db";
import { CreateRoutePlanStopResponse } from "@workspace/api-zod";
import { createStop, PlanStopConflictError } from "./stop-service";

test("late stop belongs only to the selected plan, stays unassigned, and rejects stale or foreign revisions", async () => {
  const organizationId = randomUUID();
  const otherOrgId = randomUUID();
  const planId = randomUUID();
  const otherPlanId = randomUUID();
  const routeId = randomUUID();
  const completedRouteId = randomUUID();
  const otherRouteId = randomUUID();
  const date = new Date();
  await db.insert(organizationsTable).values([
    { id: organizationId, name: "Late stop org", email: `${organizationId}@example.test` },
    { id: otherOrgId, name: "Other org", email: `${otherOrgId}@example.test` },
  ]);
  try {
    await db.insert(routesTable).values([
      { id: routeId, organizationId, planId, name: "Plan A", date, status: "optimized", planningSummary: {
        complete: true, objective: "balanced", travelReservePercent: 0, stopReserveMin: 0,
        mandatoryUnplannedStopIds: [], selectedPairValues: [], usedPairValues: [],
        unusedPairValues: [], unplanned: [],
      } },
      { id: completedRouteId, organizationId, planId, name: "Finished route", date, status: "completed" },
      { id: otherRouteId, organizationId, planId: otherPlanId, name: "Plan B", date, status: "optimized" },
    ]);
    const input = { organizationId, address: "Testgatan 1", latitude: 59.3, longitude: 18.0 };
    const plan = { planId, routes: [
      { routeId, planRevision: 0 },
      { routeId: completedRouteId, planRevision: 0 },
    ] };
    const stop = await createStop({ ...input }, plan);
    assert.equal(CreateRoutePlanStopResponse.parse(stop).id, stop.id);
    assert.equal(stop.planningPlanId, planId);
    assert.equal(stop.routeId, null);
    assert.equal(stop.status, "pending");
    const [route] = await db.select().from(routesTable).where(eq(routesTable.id, routeId));
    assert.equal(route.planningSummary?.complete, false);
    assert.deepEqual(route.planningSummary?.mandatoryUnplannedStopIds, [stop.id]);
    assert.equal(route.planRevision, 1);
    const [completedRoute] = await db.select().from(routesTable).where(eq(routesTable.id, completedRouteId));
    assert.equal(completedRoute.planRevision, 0);
    assert.equal((await db.select().from(stopsTable).where(and(
      eq(stopsTable.organizationId, organizationId), eq(stopsTable.planningPlanId, otherPlanId),
    ))).length, 0);

    await assert.rejects(createStop({ ...input }, plan), PlanStopConflictError);
    await assert.rejects(createStop({ ...input, planningPlanId: otherPlanId }));
    await assert.rejects(createStop({ ...input, organizationId: otherOrgId }, plan), PlanStopConflictError);
    assert.equal((await db.select().from(stopsTable).where(eq(stopsTable.organizationId, organizationId))).length, 1);
  } finally {
    await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
    await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
    await db.delete(organizationsTable).where(eq(organizationsTable.id, otherOrgId));
  }
});