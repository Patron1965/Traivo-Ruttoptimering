import { expect, test } from "@playwright/test";

test("route plan links open the matching traffic view and remain accessible on desktop and mobile", async ({ page, context }) => {
  test.setTimeout(90_000);
  const longRouteName = "Körning a – Västra Stockholm och Södertälje – förmiddagstur med planerade kundbesök";
  const writes: string[] = [];
  const routes = [
    { id: "a", planId: "plan-one", status: "optimized" },
    { id: "b", planId: "plan-one", status: "cancelled" },
    { id: "c", planId: "plan-two", status: "optimized" },
    { id: "legacy", planId: null, status: "completed" },
  ].map((route, index) => ({
    ...route, name: index === 0 ? longRouteName : `Körning ${route.id}`, vehicleId: `v${index}`, date: "2026-09-14",
    createdAt: "2026-09-14T07:00:00Z", updatedAt: "2026-09-14T07:00:00Z",
    planRevision: 0,
    totalStops: 1, totalDistanceKm: 12, totalDurationMin: 30,
    depotSnapshot: { start: { latitude: 59.3, longitude: 18.1 }, end: { latitude: 59.3, longitude: 18.1 } },
  }));
  const stops = [...routes.map((route, index) => ({
    id: `s${index}`, routeId: route.id, address: `Stopp ${index}`, sequenceOrder: 1,
    latitude: index === 2 ? null : 59.35 + index / 100, longitude: 18.15,
    status: route.status === "completed" ? "completed" : "pending",
    serviceDuration: 5,
  })), ...Array.from({ length: 397 }, (_, index) => ({
    id: `unplanned-${index}`, routeId: null, sequenceOrder: 0,
    planningPlanId: index === 0 ? "plan-one" : index === 1 ? "plan-two" : index % 2 ? "old-plan" : null,
    address: `Oplanerat teststopp ${index}`, latitude: 59.35, longitude: 18.15,
    status: "pending", serviceDuration: 5, createdAt: "2026-09-14T07:00:00Z",
  }))];
  await context.route("**/api/**", async (request) => {
    if (!["GET", "HEAD", "OPTIONS"].includes(request.request().method())) {
      writes.push(`${request.request().method()} ${new URL(request.request().url()).pathname}`);
    }
    const path = new URL(request.request().url()).pathname;
    let body: unknown = {};
    if (path.endsWith("/auth/me")) body = { user: { id: "fixture", name: "Test", role: "admin", organizationId: "fixture" } };
    else if (path === "/api/routes") body = routes;
    else if (path === "/api/stops") body = stops;
    else if (/^\/api\/routes\/[^/]+\/stops$/.test(path)) {
      body = stops.filter((stop) => stop.routeId === path.split("/")[3]);
    } else if (/^\/api\/routes\/[^/]+$/.test(path)) {
      body = routes.find((route) => route.id === path.split("/")[3]);
    }
    else if (path === "/api/vehicles") body = routes.map((route, index) => ({
      id: route.vehicleId, name: `Fordon ${index}`, licensePlate: `ABC00${index}`, routeColor: ["#0891B2", "#059669", "#D97706", "#7C3AED"][index],
    }));
    else if (path.includes("/osrm/route")) {
      await new Promise((resolve) => setTimeout(resolve, 300));
      body = { code: "Ok", routes: [{ geometry: "" }] };
    } else if (path.includes("drivers") || path.includes("planning-drafts")) body = [];
    await request.fulfill({ json: body });
  });
  await page.goto("/routes");
  for (const width of [1440, 320]) {
    await page.setViewportSize({ width, height: 900 });
    const plan = page.getByTestId("button-select-plan-plan:plan-one");
    const expand = page.getByTestId("button-toggle-plan-plan:plan-one");
    await expect(plan).toHaveAttribute("href", "/dispatch?view=traffic&planId=plan-one");
    await plan.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/dispatch\?view=traffic&planId=plan-one$/);
    await expect(page.getByTestId("dispatch-header-detail")).toContainText("2026");
    await expect(page.getByTestId("dispatch-unplanned-count")).toHaveText("1");

    await page.goto("/routes");
    // The plan link must not toggle the chevron or destructive checkboxes.
    await expect(expand).toHaveAttribute("aria-expanded", "false");
    await expect(page.getByTestId("button-select-plan-plan:plan-one")).toHaveAttribute(
      "href",
      "/dispatch?view=traffic&planId=plan-one",
    );
    if (await expand.getAttribute("aria-expanded") !== "true") await expand.click();
    const row = page.getByTestId("button-select-route-a");
    await expect(row).toHaveAttribute("href", "/dispatch?view=traffic&planId=plan-one&routeId=a");
    await row.focus();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(/\/dispatch\?view=traffic&planId=plan-one&routeId=a$/);
    await expect(page.getByTestId("dispatch-header-title")).toContainText("Körning a");
    await expect(page.getByTestId("dispatch-unplanned-count")).toHaveText("1");
    await expect(page.getByTestId("dispatch-reoptimization-route-select")).toHaveValue("a");
    const title = page.getByTestId("dispatch-header-title");
    await expect(title).toHaveText(longRouteName);
    expect(await title.evaluate((element) => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
    await expect(page.getByTestId("dispatch-import-plan-approval")).toHaveCount(0);

    if (width === 1440) {
      for (const viewport of [{ width: 1440, height: 900 }, { width: 1024, height: 768 }]) {
        await page.setViewportSize(viewport);
        const split = page.getByTestId("dispatch-split");
        await expect(split).toBeVisible();
        const splitBox = await split.boundingBox();
        expect(splitBox!.height).toBeGreaterThan(viewport.height * 0.55);
        for (const panel of ["dispatch-map-panel", "dispatch-timeline-panel"]) {
          await expect(page.getByTestId(panel)).toBeVisible();
          expect((await page.getByTestId(panel).boundingBox())!.height).toBeGreaterThan(140);
        }
        await page.screenshot({ path: `screenshots/route-entry-planning-${viewport.width}.png` });
      }
      await page.getByTestId("dispatch-plan-workflow-open").click();
      await expect(page.getByTestId("dispatch-plan-workflow-dialog")).toBeVisible();
      await expect(page.getByTestId("dispatch-import-plan-approval")).toBeVisible();
      await page.keyboard.press("Escape");
      await expect(page.getByTestId("dispatch-plan-workflow-dialog")).toHaveCount(0);
      expect(writes).toEqual([]);
      await page.setViewportSize({ width: 1440, height: 900 });
      const popupPromise = page.waitForEvent("popup");
      await page.getByTestId("button-gantt-popout").click();
      const popup = await popupPromise;
      await expect(popup).toHaveURL(/\/gantt-popout\?planId=plan-one&routeId=a$/);
      await expect(popup.getByTestId("gantt-popout-counts")).toHaveText(/2 .* · 3 /);
      await expect(popup.getByTestId("gantt-popout-plan")).toContainText("Körning a");
      await expect(popup.getByText("Körning c", { exact: true })).toHaveCount(0);
      await popup.reload();
      await expect(popup.getByTestId("gantt-popout-counts")).toHaveText(/2 .* · 3 /);
      await page.getByTestId("dispatch-all-plans").click();
      await expect(page.getByTestId("dispatch-unplanned-count")).toHaveText("2");
      await expect(popup).toHaveURL(/\/gantt-popout$/);
      await expect(popup.getByTestId("gantt-popout-plan")).toHaveCount(0);
      await popup.close();
      await page.getByTestId("dispatch-extra-tools").locator("summary").click();
      await page.getByTestId("dispatch-reoptimization-route-select").selectOption("c");
      await expect(page.getByTestId("dispatch-unplanned-count")).toHaveText("1");
      await page.getByTestId("dispatch-reoptimization-route-select").selectOption("");
      await expect(page.getByTestId("dispatch-unplanned-count")).toHaveText("2");
      await page.goto("/dispatch?view=traffic&routeId=c");
      await expect(page.getByTestId("dispatch-unplanned-count")).toHaveText("1");
      await page.reload();
      await expect(page.getByTestId("dispatch-unplanned-count")).toHaveText("1");
    }

    await page.goto("/routes");
    await page.getByRole("tab", { name: /^all$|^alla$/i }).click();
    await page.getByTestId("button-toggle-plan-legacy:legacy").click();
    const terminalRoute = page.getByTestId("button-select-route-legacy");
    await expect(terminalRoute).toHaveAttribute("href", "/dispatch?view=traffic&routeId=legacy");
    expect(await page.locator("button button, button a").count()).toBe(0);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1)).toBe(true);
    await page.screenshot({ path: `screenshots/route-plan-map-${width}.png` });
    await terminalRoute.click();
    await expect(page.getByTestId("dispatch-header-title")).toContainText("Körning legacy");
    await expect(page.getByTestId("dispatch-unplanned-count")).toHaveCount(0);
    await expect(page.getByTestId("dispatch-route-intent-error")).toHaveCount(0);
    await page.goto("/routes");
  }
  expect(writes).toEqual([]);
});