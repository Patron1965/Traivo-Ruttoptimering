import { expect, type Locator, type Page } from "@playwright/test";
import {
  authenticatedOrganizationId,
  e2eEmail,
  e2ePassword,
  login,
  test,
} from "./auth";

test.setTimeout(120_000);

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

async function visibleDropPoint(
  page: Page,
  target: Locator,
  routeId: string,
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
        const visibleBottom = Math.min(
          containerRect.bottom,
          window.innerHeight,
        );
        const delta =
          targetRect.top < visibleTop
            ? targetRect.top - visibleTop
            : targetRect.bottom > visibleBottom
              ? targetRect.bottom - visibleBottom
              : 0;
        current.scrollTop = Math.max(
          0,
          Math.min(
            current.scrollHeight - current.clientHeight,
            current.scrollTop + delta,
          ),
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

        const left = Math.max(0, box.x);
        const right = Math.min(viewport.width, box.x + box.width);
        const top = Math.max(0, box.y);
        const bottom = Math.min(viewport.height, box.y + box.height);
        for (let y = top + 5; y < bottom; y += 10) {
          for (let x = left + 5; x < right; x += 20) {
            const hit = await page.evaluate(
              ({ x, y, routeId: expectedRouteId }) =>
                document
                  .elementFromPoint(x, y)
                  ?.closest("[data-timeline-route-id]")
                  ?.getAttribute("data-timeline-route-id") === expectedRouteId,
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
  if (!point) throw new Error(`No visible point found for ${routeId}`);
  return point;
}

async function dragStopToRoute(
  page: Page,
  stop: Locator,
  target: Locator,
  routeId: string,
): Promise<void> {
  const sourceBox = await stop.boundingBox();
  expect(sourceBox).not.toBeNull();
  const targetPoint = await visibleDropPoint(page, target, routeId);
  await stop.dispatchEvent("mousedown", {
    button: 0,
    buttons: 1,
    clientX: sourceBox!.x + sourceBox!.width / 2,
    clientY: sourceBox!.y + sourceBox!.height / 2,
  });
  await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 });
  await page.mouse.up();
}

test("a one-time dispatch 401 asks for reauthentication without replaying the move", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);
  const suffix = `reauth-${Date.now().toString(36)}`;
  let vehicleId: string | undefined;
  let routeId: string | undefined;
  let stopId: string | undefined;
  let moveAttempts = 0;

  try {
    const vehicleResponse = await api(page, "/api/vehicles", "POST", {
      organizationId,
      name: `E2E reauth vehicle ${suffix}`,
      licensePlate: `E2E-${suffix}`,
      vehicleType: "fossil",
      capacityKg: 1_000,
      capacityVolume: 10,
      isActive: true,
    });
    expect(vehicleResponse.status).toBe(201);
    vehicleId = vehicleResponse.body.id;

    const routeResponse = await api(page, "/api/routes", "POST", {
      organizationId,
      vehicleId,
      name: `E2E reauth route ${suffix}`,
      date: "2026-08-26T00:00:00.000Z",
    });
    expect(routeResponse.status).toBe(201);
    routeId = routeResponse.body.id;

    const stopResponse = await api(
      page, `/api/import/route-plans/${routeResponse.body.planId}/stops`, "POST", {
        routes: [{ routeId, planRevision: routeResponse.body.planRevision }],
        stop: {
          organizationId,
          address: `E2E reauth stop ${suffix}`,
          latitude: 59.3293,
          longitude: 18.0686,
          jobType: "delivery",
        },
      },
    );
    expect(stopResponse.status).toBe(201);
    stopId = stopResponse.body.id;

    await page.reload();
    const lane = page.getByTestId("unscheduled-stops-lane");
    const ganttBody = page.getByTestId("dispatch-gantt-body");
    const stop = lane.locator(
      `[data-testid="unscheduled-stop-node"][data-stop-id="${stopId}"]`,
    );
    const target = ganttBody.locator(`[data-timeline-route-id="${routeId}"]`);
    await expect(stop).toBeVisible();
    await expect(target).toBeVisible();
    // Keep the timeline row in the viewport after the failed move retains
    // the selected lane. This changes only test geometry, not the assertion.
    await page.getByTestId("dispatch-map-toggle").click();

    await page.route("**/api/stops/dispatch-move", async (route) => {
      if (route.request().method() !== "POST") {
        await route.continue();
        return;
      }
      moveAttempts += 1;
      if (moveAttempts === 1) {
        await route.fulfill({
          status: 401,
          contentType: "application/json",
          body: JSON.stringify({ error: "Unauthorized" }),
        });
        return;
      }
      await route.continue();
    });

    await dragStopToRoute(page, stop, target, routeId);
    const reauthDialog = page.getByTestId("dispatch-reauth-dialog");
    await expect(reauthDialog).toBeVisible();
    await expect(reauthDialog).toContainText(
      /sessionen har gått ut|session has expired/i,
    );
    await expect(stop).toBeVisible();
    expect(moveAttempts).toBe(1);

    const emailField = reauthDialog.locator("#dispatch-reauth-email");
    await expect(emailField).toHaveValue(e2eEmail!);
    await expect(emailField).toHaveAttribute("readonly", "");
    await reauthDialog.locator("#dispatch-reauth-password").fill(e2ePassword!);
    await reauthDialog
      .getByRole("button", { name: /Logga in igen|Sign in again/i })
      .click();
    await expect(reauthDialog).toBeHidden();
    await expect(
      page
        .getByText(/Försök dra stoppet igen|Try dragging the stop again/i)
        .first(),
    ).toBeVisible();
    expect(moveAttempts).toBe(1);

    await dragStopToRoute(page, stop, target, routeId);
    await expect
      .poll(async () => {
        const response = await api(
          page,
          `/api/stops?organizationId=${organizationId}`,
        );
        if (response.status !== 200 || !Array.isArray(response.body)) {
          return null;
        }
        return response.body.find(
          (candidate: { id: string }) => candidate.id === stopId,
        )?.routeId;
      })
      .toBe(routeId);
    expect(moveAttempts).toBe(2);
  } finally {
    await page.unroute("**/api/stops/dispatch-move").catch(() => undefined);
    if (stopId) {
      await api(page, "/api/stops/bulk-delete", "POST", { stopIds: [stopId] });
    }
    if (routeId) await api(page, `/api/routes/${routeId}`, "DELETE");
    if (vehicleId) await api(page, `/api/vehicles/${vehicleId}`, "DELETE");
  }
});
