import { expect, type Locator, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { authenticatedOrganizationId, login, test } from "./auth";

test.setTimeout(120_000);

// Leave room for the plan summary and both panels' 120px minimum height.
// At 768px tall the map already starts near its minimum, so a 100px
// shrink cannot exercise the expected resize distance.
test.use({ viewport: { width: 1024, height: 1200 } });

let seededStopId: string | null = null;
let seededRouteId: string | null = null;
let seededVehicleId: string | null = null;

async function api(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: any }> {
  return page.evaluate(
    async ({ path: requestPath, method: requestMethod, body: requestBody }) => {
      const options: RequestInit = {
        method: requestMethod,
        credentials: "include",
      };
      if (requestBody !== undefined) {
        options.headers = { "Content-Type": "application/json" };
        options.body = JSON.stringify(requestBody);
      }
      const response = await fetch(requestPath, options);
      return {
        status: response.status,
        body: await response.json().catch(() => null),
      };
    },
    { path, method, body },
  );
}

test.afterEach(async ({ page }) => {
  if (seededStopId) await api(page, `/api/stops/${seededStopId}`, "DELETE");
  if (seededRouteId) await api(page, `/api/routes/${seededRouteId}`, "DELETE");
  if (seededVehicleId) await api(page, `/api/vehicles/${seededVehicleId}`, "DELETE");
  seededStopId = null;
  seededRouteId = null;
  seededVehicleId = null;
});

async function box(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(
    bounds,
    "expected element to have a visible bounding box",
  ).not.toBeNull();
  return bounds!;
}

async function expectUsablePane(locator: Locator) {
  await expect(locator).toBeVisible();
  const bounds = await box(locator);
  expect(bounds.width).toBeGreaterThan(500);
  expect(bounds.height).toBeGreaterThan(100);
}

async function dragSplit(page: Page, deltaY: number) {
  const handle = page.getByTestId("dispatch-split-handle");
  const bounds = await box(handle);
  const x = bounds.x + bounds.width / 2;
  const y = bounds.y + bounds.height / 2;

  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + deltaY, { steps: 2 });
  await page.mouse.up();
}

async function expectLeafletToCoverMap(page: Page) {
  const mapPanel = page.getByTestId("dispatch-map-panel");
  const map = mapPanel.locator(".leaflet-container");

  await expect(map).toBeVisible();
  let lastCoverage: Record<string, unknown> | null = null;
  try {
    await expect
      .poll(
        () =>
          map.evaluate((container) => {
          const bounds = container.getBoundingClientRect();
          const centerX = bounds.left + bounds.width / 2;
          const centerY = bounds.top + bounds.height / 2;
          const tiles = Array.from(
            container.querySelectorAll<HTMLElement>(".leaflet-tile"),
          ).map((tile) => tile.getBoundingClientRect());

          const horizontal = tiles.filter(
            (tile) => tile.top <= centerY && tile.bottom >= centerY,
          );
          const vertical = tiles.filter(
            (tile) => tile.left <= centerX && tile.right >= centerX,
          );

          const covered =
            horizontal.length > 0 &&
            vertical.length > 0 &&
            Math.min(...horizontal.map((tile) => tile.left)) <=
              bounds.left + 2 &&
            Math.max(...horizontal.map((tile) => tile.right)) >=
              bounds.right - 2 &&
            Math.min(...vertical.map((tile) => tile.top)) <= bounds.top + 2 &&
            Math.max(...vertical.map((tile) => tile.bottom)) >=
              bounds.bottom - 2;

          return {
            covered,
            bounds: {
              left: bounds.left,
              top: bounds.top,
              right: bounds.right,
              bottom: bounds.bottom,
              width: bounds.width,
              height: bounds.height,
            },
            horizontalCount: horizontal.length,
            verticalCount: vertical.length,
            horizontalLeft: horizontal.length
              ? Math.min(...horizontal.map((tile) => tile.left))
              : null,
            horizontalRight: horizontal.length
              ? Math.max(...horizontal.map((tile) => tile.right))
              : null,
            verticalTop: vertical.length
              ? Math.min(...vertical.map((tile) => tile.top))
              : null,
            verticalBottom: vertical.length
              ? Math.max(...vertical.map((tile) => tile.bottom))
              : null,
          };
        }).then((coverage) => {
          lastCoverage = coverage;
          return coverage.covered;
        }),
        {
          message:
            "Leaflet tiles should cover the resized map without a blank gutter",
        },
      )
      .toBe(true);
  } catch (error) {
    console.error("Leaflet coverage diagnostics:", lastCoverage);
    throw error;
  }
}

async function expectUnifiedGanttRows(page: Page) {
  const rows = page.getByTestId("dispatch-gantt-row");
  await expect(rows.first()).toBeVisible();

  const measurements = await rows.evaluateAll((routeRows) =>
    routeRows.map((routeRow) => {
      const label = routeRow.querySelector<HTMLElement>(
        '[data-testid="dispatch-route-label"]',
      );
      const timeline = routeRow.querySelector<HTMLElement>(
        '[data-testid="dispatch-timeline-row"]',
      );
      const labelBounds = label?.getBoundingClientRect();
      const timelineBounds = timeline?.getBoundingClientRect();

      return {
        routeId: routeRow.getAttribute("data-route-row-id"),
        labelRouteId: label?.getAttribute("data-route-label-id"),
        timelineRouteId: timeline?.getAttribute("data-timeline-route-id"),
        driverName:
          label
            ?.querySelector<HTMLElement>(
              '[data-testid="dispatch-driver-name"]',
            )
            ?.textContent?.trim() ?? "",
        sameParent:
          label?.parentElement === routeRow &&
          timeline?.parentElement === routeRow,
        topDifference:
          labelBounds && timelineBounds
            ? Math.abs(labelBounds.top - timelineBounds.top)
            : Number.POSITIVE_INFINITY,
        heightDifference:
          labelBounds && timelineBounds
            ? Math.abs(labelBounds.height - timelineBounds.height)
            : Number.POSITIVE_INFINITY,
      };
    }),
  );

  expect(measurements.length).toBeGreaterThan(0);
  for (const measurement of measurements) {
    expect(measurement.sameParent).toBe(true);
    expect(measurement.labelRouteId).toBe(measurement.routeId);
    expect(measurement.timelineRouteId).toBe(measurement.routeId);
    expect(measurement.driverName.length).toBeGreaterThan(0);
    expect(measurement.topDifference).toBeLessThanOrEqual(0.5);
    expect(measurement.heightDifference).toBeLessThanOrEqual(0.5);
  }
}

test("map and timeline remain usable through resize, hide, restore, and focus mode", async ({
  page,
}) => {
  const operationalWrites: string[] = [];
  page.on("request", (request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      const pathname = new URL(request.url()).pathname;
      if (pathname !== "/api/auth/login") {
        operationalWrites.push(`${request.method()} ${pathname}`);
      }
    }
  });

  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);
  const suffix = randomUUID().slice(0, 8);
  const vehicle = await api(page, "/api/vehicles", "POST", {
    organizationId,
    name: `E2E resize vehicle ${suffix}`,
    licensePlate: `RSZ-${suffix}`,
    vehicleType: "fossil",
    capacityKg: 1_000,
    capacityVolume: 10,
    isActive: true,
  });
  expect(vehicle.status).toBe(201);
  seededVehicleId = vehicle.body.id;
  const route = await api(page, "/api/routes", "POST", {
    organizationId,
    vehicleId: seededVehicleId,
    name: `E2E resize route ${suffix}`,
    date: new Date().toISOString(),
  });
  expect(route.status).toBe(201);
  seededRouteId = route.body.id;
  const seededStop = await api(page, "/api/stops", "POST", {
    organizationId,
    address: "E2E resize layout stop",
    latitude: 59.3293,
    longitude: 18.0686,
    serviceDurationMin: 15,
    jobType: "delivery",
  });
  expect(seededStop.status).toBe(201);
  seededStopId = seededStop.body.id;
  const seededAssignment = await api(
    page,
    `/api/stops/${seededStopId}/dispatch-assignment`,
    "POST",
    { routeId: seededRouteId, sequenceOrder: 1 },
  );
  expect(seededAssignment.status).toBe(200);
  await page.reload();
  operationalWrites.length = 0;

  const split = page.getByTestId("dispatch-split");
  const mapPanel = page.getByTestId("dispatch-map-panel");
  const timelinePanel = page.getByTestId("dispatch-timeline-panel");

  await expect(split).toBeVisible();
  await expect(page.getByTestId("dispatch-driver-header")).toContainText(
    /Förare|Drivers/i,
  );
  await expectUsablePane(mapPanel);
  await expectUsablePane(timelinePanel);
  await expectLeafletToCoverMap(page);
  await expectUnifiedGanttRows(page);

  const initialMapHeight = (await box(mapPanel)).height;
  await dragSplit(page, -100);
  await expect
    .poll(async () => (await box(mapPanel)).height)
    .toBeLessThan(initialMapHeight - 50);
  await expectUsablePane(mapPanel);
  await expectUsablePane(timelinePanel);

  const shrunkenMapHeight = (await box(mapPanel)).height;
  await dragSplit(page, 160);
  await expect
    .poll(async () => (await box(mapPanel)).height)
    .toBeGreaterThan(shrunkenMapHeight + 80);
  await expectUsablePane(mapPanel);
  await expectUsablePane(timelinePanel);

  const splitBounds = await box(split);
  const timelineBeforeHide = await box(timelinePanel);
  await page.getByTestId("button-layout-timeline").click();
  await expect(mapPanel).toHaveCount(0);
  await expect(page.getByTestId("dispatch-split-handle")).toHaveCount(0);
  await expect
    .poll(async () => (await box(timelinePanel)).height)
    .toBeGreaterThan(timelineBeforeHide.height + 100);

  const expandedTimeline = await box(timelinePanel);
  expect(Math.abs(expandedTimeline.y - splitBounds.y)).toBeLessThanOrEqual(2);
  expect(
    Math.abs(expandedTimeline.height - splitBounds.height),
  ).toBeLessThanOrEqual(2);

  await page.getByTestId("button-layout-split").click();
  await expectUsablePane(mapPanel);
  await expectUsablePane(timelinePanel);
  await expectLeafletToCoverMap(page);
  await expectUnifiedGanttRows(page);

  const firstStop = page.getByTestId("dispatch-stop-block").first();
  await expect(firstStop).toBeVisible();
  await firstStop.dispatchEvent("click");
  const stopDetails = page.getByTestId("dispatch-stop-detail-panel");
  await expect(stopDetails).toBeVisible();
  await expect(page.getByTestId("dispatch-stop-order-data")).toBeVisible();
  await expect
    .poll(async () => (await box(stopDetails)).width)
    .toBeLessThanOrEqual(322);

  await page.getByTestId("dispatch-focus-toggle").dispatchEvent("click");
  await expect(page.getByTestId("dispatch-focus-exit")).toBeVisible();
  await expectUsablePane(mapPanel);
  await expectUsablePane(timelinePanel);

  const focusMapHeight = (await box(mapPanel)).height;
  await dragSplit(page, -70);
  await expect
    .poll(async () => (await box(mapPanel)).height)
    .toBeLessThan(focusMapHeight - 30);
  await expectUsablePane(mapPanel);
  await expectUsablePane(timelinePanel);
  await expectLeafletToCoverMap(page);
  await expectUnifiedGanttRows(page);

  await page.getByTestId("dispatch-focus-exit").dispatchEvent("click");
  await expect(page.getByTestId("dispatch-focus-toggle")).toBeVisible();
  expect(operationalWrites).toEqual([]);
});
