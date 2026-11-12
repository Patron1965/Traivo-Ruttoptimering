import { expect, test, type BrowserContext, type Page } from "@playwright/test";

const organizationId = "10000000-0000-4000-8000-000000000001";
const planId = "20000000-0000-4000-8000-000000000001";
const routeAId = "30000000-0000-4000-8000-000000000001";
const routeBId = "30000000-0000-4000-8000-000000000002";
const vehicleAId = "40000000-0000-4000-8000-000000000001";
const vehicleBId = "40000000-0000-4000-8000-000000000002";
const driverAId = "50000000-0000-4000-8000-000000000001";
const driverBId = "50000000-0000-4000-8000-000000000002";
const stopA1Id = "60000000-0000-4000-8000-000000000001";
const stopA2Id = "60000000-0000-4000-8000-000000000002";
const stopB1Id = "60000000-0000-4000-8000-000000000003";

type MovePayload = {
  stopIds: string[];
  routeId: string | null;
  targetIndex: number;
  force: boolean;
  routeRevisions: Array<{ routeId: string; planRevision: number }>;
};

type FixtureRoute = {
  id: string;
  planId: string;
  organizationId: string;
  status: string;
  name: string;
  vehicleId: string;
  date: string;
  routeColor: string;
  planRevision: number;
  totalStops: number;
  totalDistanceKm: number;
  totalDurationMin: number;
  createdAt: string;
  updatedAt: string;
};

type FixtureStop = {
  id: string;
  organizationId: string;
  planningPlanId: string;
  routeId: string;
  address: string;
  latitude: number;
  longitude: number;
  sequenceOrder: number;
  serviceDurationMin: number;
  status: string;
  jobType: string;
};

type MoveAttempt = {
  payload: MovePayload;
  status: number;
};

type GanttFixture = {
  routes: FixtureRoute[];
  stops: FixtureStop[];
  moves: MoveAttempt[];
  getRouteLists: number;
  getStopLists: number;
};

function createFixture(): GanttFixture {
  const date = "2026-09-14";
  return {
    routes: [
      {
        id: routeAId,
        planId,
        organizationId,
        status: "optimized",
        name: "Synthetic Alpha",
        vehicleId: vehicleAId,
        date,
        routeColor: "#0891B2",
        planRevision: 7,
        totalStops: 2,
        totalDistanceKm: 12,
        totalDurationMin: 45,
        createdAt: `${date}T07:00:00Z`,
        updatedAt: `${date}T07:00:00Z`,
      },
      {
        id: routeBId,
        planId,
        organizationId,
        status: "optimized",
        name: "Synthetic Beta",
        vehicleId: vehicleBId,
        date,
        routeColor: "#059669",
        planRevision: 12,
        totalStops: 1,
        totalDistanceKm: 8,
        totalDurationMin: 30,
        createdAt: `${date}T07:00:00Z`,
        updatedAt: `${date}T07:00:00Z`,
      },
    ],
    stops: [
      {
        id: stopA1Id,
        organizationId,
        planningPlanId: planId,
        routeId: routeAId,
        address: "Synthetic Alpha stop one",
        latitude: 59.31,
        longitude: 18.12,
        sequenceOrder: 1,
        serviceDurationMin: 5,
        status: "pending",
        jobType: "delivery",
      },
      {
        id: stopA2Id,
        organizationId,
        planningPlanId: planId,
        routeId: routeAId,
        address: "Synthetic Alpha stop two",
        latitude: 59.32,
        longitude: 18.13,
        sequenceOrder: 2,
        serviceDurationMin: 5,
        status: "pending",
        jobType: "delivery",
      },
      {
        id: stopB1Id,
        organizationId,
        planningPlanId: planId,
        routeId: routeBId,
        address: "Synthetic Beta stop one",
        latitude: 59.41,
        longitude: 18.22,
        sequenceOrder: 1,
        serviceDurationMin: 5,
        status: "pending",
        jobType: "delivery",
      },
    ],
    moves: [],
    getRouteLists: 0,
    getStopLists: 0,
  };
}

async function installSyntheticApi(
  context: BrowserContext,
  fixture: GanttFixture,
  role: "admin" | "viewer" = "admin",
  moveStatus = 200,
): Promise<void> {
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const { pathname } = new URL(request.url());

    if (pathname === "/api/auth/me") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          user: {
            id: "70000000-0000-4000-8000-000000000001",
            name: "Synthetic Gantt test",
            email: "gantt-move@example.test",
            role,
            organizationId,
            driverProfileId: null,
          },
          session: null,
        }),
      });
      return;
    }

    if (request.method() === "GET" && pathname === "/api/routes") {
      fixture.getRouteLists += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixture.routes),
      });
      return;
    }

    if (request.method() === "GET" && pathname === "/api/stops") {
      fixture.getStopLists += 1;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(fixture.stops),
      });
      return;
    }

    if (request.method() === "GET" && pathname === "/api/vehicles") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          {
            id: vehicleAId,
            name: "Synthetic van A",
            licensePlate: "SYN-A",
            routeColor: "#0891B2",
            vehicleType: "fossil",
            capacityKg: 1500,
            capacityVolume: 12,
            isActive: true,
          },
          {
            id: vehicleBId,
            name: "Synthetic van B",
            licensePlate: "SYN-B",
            routeColor: "#059669",
            vehicleType: "fossil",
            capacityKg: 1500,
            capacityVolume: 12,
            isActive: true,
          },
        ]),
      });
      return;
    }

    if (request.method() === "GET" && pathname === "/api/drivers") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([
          { id: driverAId, name: "Synthetic driver A", vehicleId: vehicleAId, isActive: true },
          { id: driverBId, name: "Synthetic driver B", vehicleId: vehicleBId, isActive: true },
        ]),
      });
      return;
    }

    if (request.method() === "POST" && pathname === "/api/stops/dispatch-move") {
      const payload = request.postDataJSON() as MovePayload;
      const attempt: MoveAttempt = { payload, status: moveStatus };
      fixture.moves.push(attempt);
      if (moveStatus !== 200) {
        await route.fulfill({
          status: moveStatus,
          contentType: "application/json",
          body: JSON.stringify({
            error: moveStatus === 409 ? "Synthetic plan revision conflict" : "Forbidden",
            ...(moveStatus === 409 ? { code: "DISPATCH_REVISION_CONFLICT" } : {}),
          }),
        });
        return;
      }

      const selectedIds = new Set(payload.stopIds);
      const movingStops = payload.stopIds.map((stopId) => {
        const stop = fixture.stops.find((candidate) => candidate.id === stopId);
        if (!stop) throw new Error(`Synthetic stop ${stopId} was not found`);
        return stop;
      });
      const sourceRouteIds = new Set(
        movingStops.map((stop) => stop.routeId).filter(Boolean),
      );
      const affectedRouteIds = new Set([...sourceRouteIds, payload.routeId].filter(Boolean));
      const reorderedTarget = fixture.stops
        .filter((stop) => stop.routeId === payload.routeId && !selectedIds.has(stop.id))
        .sort((a, b) => a.sequenceOrder - b.sequenceOrder);
      reorderedTarget.splice(
        Math.min(payload.targetIndex, reorderedTarget.length),
        0,
        ...movingStops,
      );

      for (const sourceRouteId of sourceRouteIds) {
        const remaining = fixture.stops
          .filter((stop) => stop.routeId === sourceRouteId && !selectedIds.has(stop.id))
          .sort((a, b) => a.sequenceOrder - b.sequenceOrder);
        remaining.forEach((stop, index) => {
          stop.sequenceOrder = index + 1;
        });
      }
      reorderedTarget.forEach((stop, index) => {
        stop.routeId = payload.routeId!;
        stop.sequenceOrder = index + 1;
      });
      for (const affectedRouteId of affectedRouteIds) {
        const routeRecord = fixture.routes.find((candidate) => candidate.id === affectedRouteId);
        if (!routeRecord) throw new Error(`Synthetic route ${affectedRouteId} was not found`);
        routeRecord.planRevision += 1;
        routeRecord.totalStops = fixture.stops.filter(
          (stop) => stop.routeId === affectedRouteId,
        ).length;
      }
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          stops: movingStops,
          conflicts: [],
        }),
      });
      return;
    }

    // Every API response is synthetic; never let this fixture reach a live
    // service or pilot tenant if the page begins requesting another endpoint.
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([]),
    });
  });
}

async function openPopout(page: Page): Promise<void> {
  await page.setViewportSize({ width: 2560, height: 1100 });
  await page.goto(`/gantt-popout?planId=${planId}`);
  await expect(page.getByTestId("gantt-popout-timeline")).toBeVisible();
  await expect(page.getByTestId("dispatch-stop-block")).toHaveCount(3);
}

function stopBlocksInRoute(page: Page, routeId: string) {
  return page
    .locator(
      `[data-testid="dispatch-gantt-row"][data-route-row-id="${routeId}"] [data-testid="dispatch-stop-block"]`,
    )
    .evaluateAll((blocks) => blocks.map((block) => block.getAttribute("data-stop-id")));
}

async function dragStop(
  page: Page,
  stopId: string,
  targetStopId: string,
  targetSide: "before" | "after",
  targetRouteId: string,
): Promise<void> {
  const source = page.locator(`[data-testid="dispatch-stop-block"][data-stop-id="${stopId}"]`);
  const target = page.locator(`[data-testid="dispatch-stop-block"][data-stop-id="${targetStopId}"]`);
  const sourceBox = await source.boundingBox();
  const targetBox = await target.boundingBox();
  if (!sourceBox || !targetBox) {
    throw new Error(`Synthetic Gantt stop blocks are not measurable: ${stopId}, ${targetStopId}`);
  }

  const destination = {
    x: targetSide === "before" ? targetBox.x + 2 : targetBox.x + targetBox.width - 2,
    y: targetBox.y + targetBox.height / 2,
  };
  const dropRoute = await page.evaluate(
    ({ x, y }) =>
      document
        .elementFromPoint(x, y)
        ?.closest("[data-timeline-route-id]")
        ?.getAttribute("data-timeline-route-id"),
    destination,
  );
  expect(dropRoute).toBe(targetRouteId);

  await page.mouse.move(sourceBox.x + sourceBox.width / 2, sourceBox.y + sourceBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(destination.x, destination.y, { steps: 8 });
  await page.mouse.up();
}

test("Gantt popout persists a same-route reorder with only that route revision and refreshes the timeline", async ({
  page,
  context,
}) => {
  const fixture = createFixture();
  await installSyntheticApi(context, fixture);
  await openPopout(page);

  const initialStopReads = fixture.getStopLists;
  const initialRouteReads = fixture.getRouteLists;
  const saved = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith("/api/stops/dispatch-move"),
  );
  await dragStop(page, stopA1Id, stopA2Id, "after", routeAId);
  const request = await saved;

  expect(request.postDataJSON()).toEqual({
    stopIds: [stopA1Id],
    routeId: routeAId,
    targetIndex: 1,
    force: false,
    routeRevisions: [{ routeId: routeAId, planRevision: 7 }],
  });
  await expect.poll(() => stopBlocksInRoute(page, routeAId)).toEqual([stopA2Id, stopA1Id]);
  await expect.poll(() => fixture.getStopLists).toBeGreaterThan(initialStopReads);
  await expect.poll(() => fixture.getRouteLists).toBeGreaterThan(initialRouteReads);
  expect(fixture.routes.find((route) => route.id === routeAId)?.planRevision).toBe(8);
  await expect.poll(() => stopBlocksInRoute(page, routeBId)).toEqual([stopB1Id]);
});

test("Gantt popout moves across routes with exact source and target revisions and refreshed assignments", async ({
  page,
  context,
}) => {
  const fixture = createFixture();
  await installSyntheticApi(context, fixture);
  await openPopout(page);

  const initialStopReads = fixture.getStopLists;
  const initialRouteReads = fixture.getRouteLists;
  const saved = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith("/api/stops/dispatch-move"),
  );
  await dragStop(page, stopA1Id, stopB1Id, "before", routeBId);
  const request = await saved;

  expect(request.postDataJSON()).toEqual({
    stopIds: [stopA1Id],
    routeId: routeBId,
    targetIndex: 0,
    force: false,
    routeRevisions: [
      { routeId: routeBId, planRevision: 12 },
      { routeId: routeAId, planRevision: 7 },
    ],
  });
  await expect.poll(() => stopBlocksInRoute(page, routeAId)).toEqual([stopA2Id]);
  await expect.poll(() => stopBlocksInRoute(page, routeBId)).toEqual([stopA1Id, stopB1Id]);
  await expect.poll(() => fixture.getStopLists).toBeGreaterThan(initialStopReads);
  await expect.poll(() => fixture.getRouteLists).toBeGreaterThan(initialRouteReads);
  expect(fixture.routes.find((route) => route.id === routeAId)?.planRevision).toBe(8);
  expect(fixture.routes.find((route) => route.id === routeBId)?.planRevision).toBe(13);
});

test("Gantt popout leaves the synthetic route unchanged after a revision conflict", async ({
  page,
  context,
}) => {
  const fixture = createFixture();
  await installSyntheticApi(context, fixture, "admin", 409);
  await openPopout(page);
  const initialStopReads = fixture.getStopLists;
  const initialRouteReads = fixture.getRouteLists;

  const saved = page.waitForRequest(
    (request) =>
      request.method() === "POST" && request.url().endsWith("/api/stops/dispatch-move"),
  );
  await dragStop(page, stopA1Id, stopB1Id, "before", routeBId);
  const request = await saved;

  expect(request.postDataJSON()).toEqual({
    stopIds: [stopA1Id],
    routeId: routeBId,
    targetIndex: 0,
    force: false,
    routeRevisions: [
      { routeId: routeBId, planRevision: 12 },
      { routeId: routeAId, planRevision: 7 },
    ],
  });
  await expect.poll(() => fixture.moves).toHaveLength(1);
  await expect(page.getByTestId("gantt-popout-move-feedback")).toContainText(/ändrades|changed/i);
  await expect.poll(() => fixture.getStopLists).toBeGreaterThan(initialStopReads);
  await expect.poll(() => fixture.getRouteLists).toBeGreaterThan(initialRouteReads);
  expect(fixture.moves[0].status).toBe(409);
  expect(await stopBlocksInRoute(page, routeAId)).toEqual([stopA1Id, stopA2Id]);
  expect(await stopBlocksInRoute(page, routeBId)).toEqual([stopB1Id]);
  expect(fixture.routes.map(({ id, planRevision }) => [id, planRevision])).toEqual([
    [routeAId, 7],
    [routeBId, 12],
  ]);
});

test("viewer Gantt popout cannot persist a stop move", async ({ page, context }) => {
  const fixture = createFixture();
  await installSyntheticApi(context, fixture, "viewer", 403);
  await openPopout(page);

  await dragStop(page, stopA1Id, stopB1Id, "before", routeBId);
  expect(fixture.moves).toHaveLength(0);
  expect(fixture.stops.find((stop) => stop.id === stopA1Id)?.routeId).toBe(routeAId);
  expect(await stopBlocksInRoute(page, routeAId)).toEqual([stopA1Id, stopA2Id]);
  expect(await stopBlocksInRoute(page, routeBId)).toEqual([stopB1Id]);
});

test("an expired session shows reauthentication without replaying the rejected move", async ({
  page,
  context,
}) => {
  const fixture = createFixture();
  await installSyntheticApi(context, fixture, "admin", 401);
  await openPopout(page);

  await dragStop(page, stopA1Id, stopB1Id, "before", routeBId);
  await expect(page.getByTestId("dispatch-reauth-dialog")).toBeVisible();
  await expect(page.getByTestId("gantt-popout-move-feedback")).toBeVisible();
  expect(fixture.moves).toHaveLength(1);
  expect(await stopBlocksInRoute(page, routeAId)).toEqual([stopA1Id, stopA2Id]);
});