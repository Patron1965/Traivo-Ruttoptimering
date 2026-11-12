import { expect, type Locator, type Page, type Request } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { authenticatedOrganizationId, login, test } from "./auth";
import { provisionDisposableAuthFixture, cleanupDisposableAuthFixture } from "./planning-draft-fixture";

test.setTimeout(240_000);

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

async function loginAt(page: Page): Promise<void> {
  await login(page, "/dispatch", "dispatch-split");
}

async function confirmGroupMove(page: Page, routeId: string): Promise<void> {
  await page.getByTestId("dispatch-bulk-open").click();
  const preview = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith("/api/stops/dispatch-move/preview"));
  await page.getByTestId("dispatch-bulk-route").selectOption(routeId);
  const previewResponse = await preview;
  const previewBody = await previewResponse.json();
  expect(previewResponse.status(), JSON.stringify(previewBody)).toBe(200);
  expect(previewBody.canMove, JSON.stringify(previewBody)).toBe(true);
  const confirm = page.getByTestId("dispatch-bulk-confirm");
  await expect(confirm).toBeEnabled();
  const saved = page.waitForResponse(response =>
    response.request().method() === "POST" && response.url().endsWith("/api/stops/dispatch-move"));
  await confirm.click();
  expect((await saved).status()).toBe(200);
  await expect(page.getByTestId("dispatch-bulk-dialog")).toBeHidden();
}

async function visibleDropPoint(
  page: Page,
  target: Locator,
  routeId: string,
  minX?: number,
): Promise<{ x: number; y: number }> {
  await target.evaluate((element) => {
    let current = element.parentElement;
    while (current) {
      const style = window.getComputedStyle(current);
      if (
        /(auto|scroll)/.test(style.overflowY) &&
        current.scrollHeight > current.clientHeight
      ) {
        const targetRect = element.getBoundingClientRect();
        const containerRect = current.getBoundingClientRect();
        const visibleTop = Math.max(containerRect.top, 0);
        const visibleBottom = Math.min(containerRect.bottom, window.innerHeight);
        const delta =
          targetRect.top < visibleTop
            ? targetRect.top - visibleTop
            : targetRect.bottom > visibleBottom
              ? targetRect.bottom - visibleBottom
              : 0;
        const maxScrollTop = current.scrollHeight - current.clientHeight;
        current.scrollTop = Math.max(
          0,
          Math.min(maxScrollTop, current.scrollTop + delta),
        );
        return;
      }
      current = current.parentElement;
    }
  });

  let point: { x: number; y: number } | null = null;
  await expect
    .poll(
      async () => {
        const box = await target.boundingBox();
        const viewport = page.viewportSize();
        if (!box || !viewport) return false;

        const left = Math.max(0, box.x, minX ?? 0);
        const right = Math.min(viewport.width, box.x + box.width);
        const top = Math.max(0, box.y);
        const bottom = Math.min(viewport.height, box.y + box.height);
        for (let y = top + 5; y < bottom; y += 10) {
          for (let x = left + 5; x < right; x += 20) {
            const hit = await page.evaluate(
              ({ x, y, routeId }) =>
                document
                  .elementFromPoint(x, y)
                  ?.closest("[data-timeline-route-id]")
                  ?.getAttribute("data-timeline-route-id") === routeId,
              { x, y, routeId },
            );
            if (hit) {
              point = { x, y };
              return true;
            }
          }
        }
        return false;
      },
      { timeout: 5_000, intervals: [50, 100, 250] },
    )
    .toBe(true);
  if (point) return point;
  throw new Error(`No visible point found for drop target ${routeId}`);
}

async function visibleStopBlockPoint(
  page: Page,
  target: Locator,
): Promise<{ x: number; y: number }> {
  const box = await target.boundingBox();
  const stopId = await target.getAttribute("data-stop-id");
  const viewport = page.viewportSize();
  if (!box || !stopId || !viewport) {
    throw new Error("Stop block is not measurable");
  }

  const left = Math.max(0, box.x);
  const right = Math.min(viewport.width, box.x + box.width);
  const top = Math.max(0, box.y);
  const bottom = Math.min(viewport.height, box.y + box.height);
  for (let y = top + 2; y < bottom; y += 4) {
    for (let x = left + 2; x < right; x += 4) {
      const hit = await page.evaluate(
        ({ x, y, stopId }) =>
          document
            .elementFromPoint(x, y)
            ?.closest("[data-testid='dispatch-stop-block']")
            ?.getAttribute("data-stop-id") === stopId,
        { x, y, stopId },
      );
      if (hit) return { x, y };
    }
  }
  throw new Error(`No visible point found for stop block ${stopId}`);
}

test("dispatch queue sits above the Gantt and completes normal and forced assignment", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const suffix = randomUUID().slice(0, 8);
  const authFixture = await provisionDisposableAuthFixture(suffix);
  const organizationId = authFixture.organizationId;
  const normalAddress = `E2E normal dispatch stop ${suffix}`;
  const groupedAddress = `E2E grouped dispatch stop ${suffix}`;
  const forcedAddress = `E2E forced dispatch stop ${suffix}`;
  const vehicleIds: string[] = [];
  const driverIds: string[] = [];
  let draftId: string | undefined;
  let routeId: string | undefined;
  let secondRouteId: string | undefined;
  let anchorStopId: string | undefined;
  let secondAnchorId: string | undefined;
  const stopIds: string[] = [];

  try {
    await page.goto("/dispatch");
    await expect(page.locator("#email")).toBeVisible();
    await page.locator("#email").fill(authFixture.email);
    await page.locator("#password").fill(authFixture.password);
    await page.locator("#password").press("Enter");
    await expect(page.getByTestId("traffic-layout-switch")).toBeVisible();
    for (let index = 0; index < 2; index++) {
      const vehicle = await api(page, "/api/vehicles", "POST", {
        organizationId,
        name: `E2E dispatch vehicle ${suffix}-${index}`,
        licensePlate: `E2E-${suffix}-${index}`,
        vehicleType: "fossil",
        capacityKg: 1_000,
        capacityVolume: 10,
        isActive: true,
        driver: { name: `E2E dispatch driver ${suffix}-${index}` },
      });
      expect(vehicle.status).toBe(201);
      vehicleIds.push(vehicle.body.id);
      const driver = vehicle.body.resourceProfile;
      expect(driver?.id).toBeTruthy();
      expect(driver.vehicleId).toBe(vehicle.body.id);
      driverIds.push(driver.id);
    }
    const anchors = [];
    for (let index = 0; index < 2; index++) {
      const anchor = await api(page, "/api/stops", "POST", {
        organizationId,
        address: `E2E existing route stop ${suffix}-${index}`,
        latitude: 59.3301 + index * 0.001,
        longitude: 18.0692 + index * 0.001,
        jobType: "delivery",
      });
      expect(anchor.status).toBe(201);
      anchors.push(anchor.body.id as string);
    }
    anchorStopId = anchors[0];
    secondAnchorId = anchors[1];
    const draft = await api(page, "/api/planning-drafts", "POST", {
      name: `E2E dispatch route ${suffix}`,
      startAt: "2099-06-26T00:00:00.000Z",
      state: { step: 6 },
    });
    expect(draft.status).toBe(201);
    draftId = draft.body.id;
    const plan = await api(page, "/api/import/route-plans", "POST", {
      draftId,
      stopIds: anchors,
      pairs: vehicleIds.map((vehicleId, index) => ({ vehicleId, driverId: driverIds[index] })),
      vehicleDistributionMode: "balance",
      date: "2099-06-26T00:00:00.000Z",
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
    });
    expect(plan.status).toBe(200);
    expect(plan.body.routes).toHaveLength(2);
    // Imported routes require a verified immutable depot snapshot; driver
    // coordinates alone are not depot verification. Seed trusted history on
    // these disposable routes, as in the planning-input acceptance fixture.
    await promisify(execFile)("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
      import { pool } from "@workspace/db";
      (async () => {
        const endpoint = { address: "E2E trusted Stockholm depot", latitude: 59.3293, longitude: 18.0686,
          verifiedAt: "2026-01-01T00:00:00.000Z", verification: { source: "trusted-e2e-fixture", method: "test-db-seed" } };
        try {
          const result = await pool.query(
            "UPDATE routes SET depot_snapshot = $1::jsonb WHERE organization_id = $2::uuid AND id = ANY($3::uuid[]) RETURNING id",
            [JSON.stringify({ start: endpoint, end: endpoint }), process.env.E2E_ORG_ID, JSON.parse(process.env.E2E_ROUTE_IDS)]
          );
          if (result.rowCount !== 2) throw new Error("Expected exactly two disposable routes");
        } finally { await pool.end(); }
      })().catch(error => { console.error(error); process.exitCode = 1; });
    `], { env: { ...process.env, E2E_ORG_ID: organizationId, E2E_ROUTE_IDS: JSON.stringify(plan.body.routes.map((item: { routeId: string }) => item.routeId)) } });
    const anchor = await api(page, `/api/stops/${anchorStopId}`);
    expect(anchor.status).toBe(200);
    routeId = anchor.body.routeId;
    expect(routeId).toBeTruthy();
    secondRouteId = plan.body.routes.find((item: { routeId: string }) => item.routeId !== routeId)?.routeId;
    expect(secondRouteId).toBeTruthy();
    const route = await api(page, `/api/routes/${routeId}`);
    expect(route.status).toBe(200);

    for (const stop of [
      { address: normalAddress, serviceDurationMin: 15 },
      { address: groupedAddress, serviceDurationMin: 45 },
      { address: forcedAddress, serviceDurationMin: 700 },
    ]) {
      const revisions = await Promise.all([routeId, secondRouteId].map(async id => {
        const current = await api(page, `/api/routes/${id}`);
        expect(current.status).toBe(200);
        return { routeId: id, planRevision: current.body.planRevision };
      }));
      const stopResponse = await api(page, `/api/import/route-plans/${plan.body.planId}/stops`, "POST", {
        routes: revisions,
        stop: {
        organizationId,
        address: stop.address,
        latitude: 59.3293,
        longitude: 18.0686,
        jobType: "delivery",
        planningDate: "2099-06-26",
        ...(stop.serviceDurationMin ? { serviceDurationMin: stop.serviceDurationMin } : {}),
        },
      });
      expect(stopResponse.status, JSON.stringify(stopResponse.body)).toBe(201);
      stopIds.push(stopResponse.body.id);
    }

    await page.reload();
    const lane = page.getByTestId("unscheduled-stops-lane");
    const ganttBody = page.getByTestId("dispatch-gantt-body");
    await expect(lane).toBeVisible();
    await expect(ganttBody).toBeVisible();

    const [laneBounds, ganttBounds] = await Promise.all([
      lane.boundingBox(),
      ganttBody.boundingBox(),
    ]);
    expect(laneBounds).not.toBeNull();
    expect(ganttBounds).not.toBeNull();
    expect(laneBounds!.y).toBeLessThan(ganttBounds!.y);

    const normalNode = lane.locator(
      `[data-testid="unscheduled-stop-node"][data-stop-id="${stopIds[0]}"]`,
    );
    await expect(normalNode).toBeVisible();
    await normalNode.click();
    const detailPanel = page.getByTestId("dispatch-stop-detail-panel");
    await expect(detailPanel).toBeVisible();
    await expect(detailPanel.getByText(normalAddress, { exact: true }).first()).toBeVisible();
    await detailPanel.getByRole("button", { name: /close|stäng/i }).click();

    const groupedNode = lane.locator(
      `[data-testid="unscheduled-stop-node"][data-stop-id="${stopIds[1]}"]`,
    );
    await groupedNode.click({ modifiers: ["Shift"] });
    await expect(normalNode).toHaveAttribute("aria-pressed", "true");
    await expect(groupedNode).toHaveAttribute("aria-pressed", "true");

    const routeDropTarget = ganttBody.locator(
      `[data-timeline-route-id="${routeId}"]`,
    );
    await confirmGroupMove(page, routeId!);
    await expect(normalNode).toHaveCount(0);
    await expect(groupedNode).toHaveCount(0);
    await expect
      .poll(async () => {
        const response = await api(page, `/api/stops?organizationId=${organizationId}`);
        if (response.status !== 200 || !Array.isArray(response.body)) return [];
        return response.body
          .filter((stop: { routeId: string }) => stop.routeId === routeId)
          .map((stop: { sequenceOrder: number }) => stop.sequenceOrder)
          .sort((a: number, b: number) => a - b);
      })
      .toEqual([1, 2, 3]);

    const normalBlock = ganttBody.locator(
      `[data-testid="dispatch-stop-block"][data-stop-id="${stopIds[0]}"]`,
    );
    const groupedBlock = ganttBody.locator(
      `[data-testid="dispatch-stop-block"][data-stop-id="${stopIds[1]}"]`,
    );
    await expect(normalBlock).toBeVisible();
    await expect(groupedBlock).toBeVisible();
    await normalBlock.hover();
    const stopTooltip = page.getByRole("tooltip").filter({ hasText: normalAddress });
    await expect(stopTooltip).toBeVisible();
    const [stopTooltipBounds, driverLabelBounds] = await Promise.all([
      stopTooltip.boundingBox(),
      page.locator(`[data-route-label-id="${routeId}"]`).boundingBox(),
    ]);
    expect(stopTooltipBounds).not.toBeNull();
    expect(driverLabelBounds).not.toBeNull();
    expect(stopTooltipBounds!.x).toBeGreaterThanOrEqual(
      driverLabelBounds!.x + driverLabelBounds!.width,
    );
    const dispatchMoveRequests: string[] = [];
    const recordDispatchMove = (request: Request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/stops/dispatch-move")
      ) {
        dispatchMoveRequests.push(request.url());
      }
    };
    page.on("request", recordDispatchMove);
    await normalBlock.click();
    page.off("request", recordDispatchMove);
    expect(dispatchMoveRequests).toEqual([]);
    await expect(page.getByTestId("dispatch-stop-detail-panel")).toBeVisible();
    await expect(stopTooltip).toBeHidden();
    await page.keyboard.press("Escape");
    // The isolated tenant selects its only plan, whose workflow header takes
    // more vertical space. Hide the map before timeline pointer operations.
    await page.getByTestId("button-layout-timeline").click();
    await page.mouse.move(0, 0);
    const [normalVisualWidth, groupedVisualWidth] = await Promise.all([
      normalBlock.locator(":scope > div").evaluate((element) => element.getBoundingClientRect().width),
      groupedBlock.locator(":scope > div").evaluate((element) => element.getBoundingClientRect().width),
    ]);
    expect(groupedVisualWidth).toBeGreaterThan(normalVisualWidth);
    const [normalBlockBounds, groupedBlockBounds] = await Promise.all([
      normalBlock.boundingBox(),
      groupedBlock.boundingBox(),
    ]);
    expect(normalBlockBounds).not.toBeNull();
    expect(groupedBlockBounds).not.toBeNull();
    const reorderPoint = await visibleDropPoint(
      page,
      ganttBody.locator(`[data-timeline-route-id="${routeId}"]`),
      routeId,
      groupedBlockBounds!.x + groupedBlockBounds!.width + 5,
    );
    await normalBlock.dispatchEvent("mousedown", {
      button: 0,
      buttons: 1,
      clientX: normalBlockBounds!.x + normalBlockBounds!.width / 2,
      clientY: normalBlockBounds!.y + normalBlockBounds!.height / 2,
    });
    await page.mouse.move(
      reorderPoint.x,
      reorderPoint.y,
      { steps: 8 },
    );
    await page.mouse.up();
    await expect(page.getByTestId("dispatch-bulk-confirm")).toBeEnabled();
    await page.getByTestId("dispatch-bulk-confirm").click();
    await expect
      .poll(async () => {
        const response = await api(page, `/api/stops?organizationId=${organizationId}`);
        if (response.status !== 200 || !Array.isArray(response.body)) return [];
        const byId = new Map(response.body.map((stop: { id: string; sequenceOrder: number }) => [stop.id, stop.sequenceOrder]));
        const values = [byId.get(stopIds[1]), byId.get(stopIds[0]), byId.get(anchorStopId!)] as number[];
        return {
          unique: new Set(values).size === 3,
          contiguous: [...values].sort((a, b) => a - b).join(",") === "1,2,3",
          movedAfterGrouped: values[1] > values[0],
        };
      })
      .toEqual({ unique: true, contiguous: true, movedAfterGrouped: true });

    // This test exercises assignment, not map resizing (covered separately).
    // Expose both rows before dragging; the map can clip the second row at
    // this viewport even when the Gantt itself has nothing left to scroll.
    await groupedBlock.click({ modifiers: ["Shift"] });
    await normalBlock.click({ modifiers: ["Shift"] });
    await confirmGroupMove(page, secondRouteId!);
    await expect
      .poll(async () => {
        const response = await api(page, `/api/stops?organizationId=${organizationId}`);
        if (response.status !== 200 || !Array.isArray(response.body)) return [];
        const byId = new Map(response.body.map((stop: { id: string; routeId: string; sequenceOrder: number }) => [stop.id, stop]));
        return [
          byId.get(stopIds[1])?.routeId,
          byId.get(stopIds[1])?.sequenceOrder,
          byId.get(stopIds[0])?.routeId,
          byId.get(stopIds[0])?.sequenceOrder,
        ];
      })
      .toEqual([secondRouteId, 2, secondRouteId, 3]);

    const forcedNode = lane.locator(
      `[data-testid="unscheduled-stop-node"][data-stop-id="${stopIds[2]}"]`,
    );
    await expect(forcedNode).toBeVisible();
    await normalBlock.click({ modifiers: ["Shift"] });
    await forcedNode.click({ modifiers: ["Shift"] });
    await expect(forcedNode).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("dispatch-bulk-open").click();
    await page.getByTestId("dispatch-bulk-route").selectOption(routeId!);
    await expect(page.getByTestId("dispatch-bulk-feasibility")).toContainText("Flytten kan inte sparas");
    await expect(page.getByTestId("dispatch-bulk-confirm")).toBeDisabled();
    await page.getByTestId("dispatch-bulk-cancel").click();
    await page.getByTestId("dispatch-bulk-clear").click();
    // A blocked group preview must not partially assign its feasible member.
    expect((await api(page, `/api/stops/${stopIds[0]}`)).body.routeId).toBe(secondRouteId);
    expect((await api(page, `/api/stops/${stopIds[2]}`)).body.routeId).toBeNull();
    await normalBlock.click({ modifiers: ["Shift"] });
    await confirmGroupMove(page, routeId!);
    const routePoint = await visibleDropPoint(page, routeDropTarget, routeId!);
    const forcedBounds = await forcedNode.boundingBox();
    expect(forcedBounds).not.toBeNull();
    await page.mouse.move(forcedBounds!.x + forcedBounds!.width / 2, forcedBounds!.y + forcedBounds!.height / 2);
    await page.mouse.down();
    await page.mouse.move(routePoint.x, routePoint.y, { steps: 8 });
    await page.mouse.up();

    const conflictDialog = page.getByRole("dialog");
    await expect(conflictDialog).toBeVisible();
    await expect(conflictDialog).toContainText(/WORKING_HOURS|Arbetstid|Arbetspasset/i);
    await conflictDialog.getByTestId("dispatch-bulk-accept-deviation").check();
    await expect(page.getByTestId("dispatch-bulk-confirm")).toBeEnabled();
    await page.getByTestId("dispatch-bulk-confirm").click();
    await expect(conflictDialog).toBeHidden();
    await expect(forcedNode).toHaveCount(0);
    await expect(
      ganttBody
        .locator(`[data-stop-id="${stopIds[2]}"]`)
        .getByTestId("working-hours-override-warning"),
    ).toBeVisible();

    const stopsResponse = await api(
      page,
      `/api/stops?organizationId=${organizationId}`,
    );
    expect(stopsResponse.status).toBe(200);
    const forcedStop = stopsResponse.body.find(
      (stop: { id: string }) => stop.id === stopIds[2],
    );
    const mixedPlannedStop = stopsResponse.body.find(
      (stop: { id: string }) => stop.id === stopIds[0],
    );
    const anchorStop = stopsResponse.body.find(
      (stop: { id: string }) => stop.id === anchorStopId,
    );
    expect(forcedStop.routeId).toBe(routeId);
    expect(mixedPlannedStop.routeId).toBe(routeId);
    expect([
      anchorStop.sequenceOrder,
      mixedPlannedStop.sequenceOrder,
      forcedStop.sequenceOrder,
    ].sort((a, b) => a - b)).toEqual([1, 2, 3]);
    expect(forcedStop.assignmentOverrideAt).toBeTruthy();
    expect(forcedStop.assignmentOverrideReasonCodes).toContain("WORKING_HOURS");

    const forcedBlock = ganttBody.locator(
      `[data-testid="dispatch-stop-block"][data-stop-id="${stopIds[2]}"]`,
    );
    await normalBlock.click({ modifiers: ["Shift"] });
    await forcedBlock.click({ modifiers: ["Shift"] });
    await page.getByTestId("dispatch-bulk-open").click();
    await page.getByTestId("dispatch-bulk-action-date").click();
    await page.getByTestId("dispatch-bulk-date").fill("2099-06-27");
    await page.getByTestId("dispatch-bulk-confirm").click();
    await expect(page.getByTestId("dispatch-bulk-dialog")).toBeHidden();
    await expect
      .poll(async () => {
        const response = await api(page, `/api/stops?organizationId=${organizationId}`);
        if (response.status !== 200 || !Array.isArray(response.body)) return [];
        const byId = new Map(response.body.map((stop: {
          id: string;
          routeId: string | null;
          planningPlanId: string | null;
          sequenceOrder: number | null;
        }) => [stop.id, stop]));
        return [
          byId.get(stopIds[0])?.routeId,
          byId.get(stopIds[2])?.routeId,
          byId.get(stopIds[0])?.planningPlanId,
          byId.get(stopIds[2])?.planningPlanId,
          byId.get(anchorStopId!)?.sequenceOrder,
        ];
      })
      .toEqual([null, null, null, null, 1]);
  } finally {
    if (stopIds.length > 0 || anchorStopId || secondAnchorId) {
      await api(page, "/api/stops/bulk-delete", "POST", {
        stopIds: [...stopIds, ...(anchorStopId ? [anchorStopId] : []), ...(secondAnchorId ? [secondAnchorId] : [])],
      });
    }
    if (routeId) {
      await api(page, `/api/routes/${routeId}`, "DELETE");
    }
    if (secondRouteId) {
      await api(page, `/api/routes/${secondRouteId}`, "DELETE");
    }
    if (draftId) {
      await api(page, `/api/planning-drafts/${draftId}`, "DELETE");
    }
    for (const driverId of driverIds) {
      await api(page, `/api/drivers/${driverId}`, "DELETE");
    }
    for (const vehicleId of vehicleIds) {
      await api(page, `/api/vehicles/${vehicleId}`, "DELETE");
    }
    await cleanupDisposableAuthFixture(authFixture);
  }
});
