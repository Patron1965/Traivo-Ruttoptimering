import { expect, test } from "@playwright/test";

for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 1100 }]) {
test(`map popout keeps the dispatch scope isolated across plans, reloads, and history (${viewport.width}x${viewport.height})`, async ({
  page,
  context,
}) => {
  await page.setViewportSize(viewport);
  const routes = [
    {
      id: "a",
      planId: "plan-one",
      status: "optimized",
      name: "Plan ett · Alpha",
      vehicleId: "v1",
      date: "2026-09-14",
      routeColor: "#0891B2",
      totalStops: 1,
    },
    {
      id: "b",
      planId: "plan-one",
      status: "cancelled",
      name: "Plan ett · Historik",
      vehicleId: "v2",
      date: "2026-09-14",
      routeColor: "#059669",
      totalStops: 1,
    },
    {
      id: "c",
      planId: "plan-two",
      status: "optimized",
      name: "Plan två · Charlie",
      vehicleId: "v3",
      date: "2026-09-15",
      routeColor: "#D97706",
      totalStops: 1,
    },
    {
      id: "d",
      planId: "plan-two",
      status: "completed",
      name: "Plan två · Slutförd",
      vehicleId: "v4",
      date: "2026-09-15",
      routeColor: "#7C3AED",
      totalStops: 1,
    },
    {
      id: "legacy",
      planId: null,
      status: "completed",
      name: "Äldre körning",
      vehicleId: "v5",
      date: "2026-09-13",
      routeColor: "#DB2777",
      totalStops: 1,
    },
  ].map((route) => ({
    ...route,
    organizationId: "fixture",
    createdAt: `${route.date}T07:00:00Z`,
    updatedAt: `${route.date}T07:00:00Z`,
    planRevision: 0,
    totalDistanceKm: 12,
    totalDurationMin: 30,
    depotSnapshot: {
      start: { latitude: 59.3, longitude: 18.1 },
      end: { latitude: 59.3, longitude: 18.1 },
    },
  }));

  const stops = [
    {
      id: "s-a",
      routeId: "a",
      planningPlanId: "plan-one",
      address: "Alpha-gatan 1",
      latitude: 59.31,
      longitude: 18.12,
      sequenceOrder: 1,
      status: "pending",
    },
    {
      id: "s-b",
      routeId: "b",
      planningPlanId: "plan-one",
      address: "Historik-gatan 2",
      latitude: 59.65,
      longitude: 18.55,
      sequenceOrder: 1,
      status: "completed",
    },
    {
      id: "s-c",
      routeId: "c",
      planningPlanId: "plan-two",
      address: "Charlie-gatan 3",
      latitude: 59.12,
      longitude: 17.72,
      sequenceOrder: 1,
      status: "pending",
    },
    {
      id: "s-d",
      routeId: "d",
      planningPlanId: "plan-two",
      address: "Slutförd-gatan 4",
      latitude: 59.86,
      longitude: 18.92,
      sequenceOrder: 1,
      status: "completed",
    },
    {
      id: "s-legacy",
      routeId: "legacy",
      planningPlanId: null,
      address: "Äldre-gatan 5",
      latitude: 58.95,
      longitude: 17.35,
      sequenceOrder: 1,
      status: "completed",
    },
    {
      id: "u-one",
      routeId: null,
      planningPlanId: "plan-one",
      address: "Oplanerad ett",
      latitude: 59.42,
      longitude: 18.3,
      sequenceOrder: null,
      status: "pending",
    },
    {
      id: "u-two",
      routeId: null,
      planningPlanId: "plan-two",
      address: "Oplanerad två",
      latitude: 59.5,
      longitude: 18.8,
      sequenceOrder: null,
      status: "pending",
    },
    {
      id: "u-legacy",
      routeId: null,
      planningPlanId: null,
      address: "Oplanerad äldre",
      latitude: 58.8,
      longitude: 17.8,
      sequenceOrder: null,
      status: "pending",
    },
  ].map((stop) => ({ ...stop, organizationId: "fixture", serviceDuration: 5 }));

  const vehicles = [
    ["v1", "Fordon ett", "#0891B2"],
    ["v2", "Fordon två", "#059669"],
    ["v3", "Fordon tre", "#D97706"],
    ["v4", "Fordon fyra", "#7C3AED"],
    ["v5", "Fordon fem", "#DB2777"],
  ].map(([id, name, routeColor], index) => ({
    id,
    name,
    licensePlate: `ABC00${index + 1}`,
    routeColor,
    vehicleType: "fossil",
    isActive: true,
  }));

  const requests: Array<{ method: string; path: string }> = [];
  await context.route("**/api/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const path = url.pathname;
    requests.push({ method: request.method(), path });

    let body: unknown = [];
    if (path.endsWith("/auth/me")) {
      body = {
        user: {
          id: "fixture-user",
          name: "Map regression",
          email: "map@example.test",
          role: "admin",
          organizationId: "fixture",
          driverProfileId: null,
        },
        session: null,
      };
    } else if (path === "/api/routes") {
      body = routes;
    } else if (path === "/api/stops") {
      body = stops;
    } else if (path === "/api/vehicles") {
      body = vehicles;
    } else if (/^\/api\/routes\/[^/]+\/stops$/.test(path)) {
      body = stops.filter((stop) => stop.routeId === path.split("/")[3]);
    } else if (/^\/api\/routes\/[^/]+$/.test(path)) {
      body = routes.find((route) => route.id === path.split("/")[3]) ?? null;
    } else if (path.includes("/osrm/route")) {
      body = { code: "Ok", routes: [{ geometry: "" }] };
    } else if (path.includes("drivers") || path.includes("planning-drafts")) {
      body = [];
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });

  // Start with both URL scope keys so the popup's direct href is tested.
  await page.goto("/dispatch?view=traffic&planId=plan-one&routeId=a");
  await expect(page.getByTestId("dispatch-header-detail")).toContainText("2026");
  for (const id of ["s-a", "u-one"]) {
    await page.locator(`[data-stop-id="${id}"]`).first().click();
    await expect.poll(async () => {
      const marker = await page.locator(`[title="stop:${id}"]`).boundingBox();
      const map = await page.locator(".leaflet-container").boundingBox();
      return marker && map ? Math.abs(marker.x + marker.width / 2 - (map.x + map.width / 2)) : 9999;
    }).toBeLessThan(45);
  }
  await page.reload();
  await expect(page.getByTestId("dispatch-split")).toBeVisible();
  const firstPopupPromise = page.waitForEvent("popup");
  await page.getByTestId("button-map-popout").click();
  const firstMap = await firstPopupPromise;
  await expect(firstMap).toHaveURL(/\/map-popout\?planId=plan-one&routeId=a$/);
  await expect(firstMap.getByTestId("map-popout-counts")).toHaveText(/2 .* · 1 /);
  await expect(firstMap.locator('[title="stop:s-a"]')).toHaveCount(1);
  await expect(firstMap.locator('[title="stop:s-b"]')).toHaveCount(1);
  for (const id of ["s-c", "s-d", "s-legacy", "u-two", "u-legacy"]) {
    await expect(firstMap.locator(`[title="stop:${id}"]`)).toHaveCount(0);
  }
  await expect(firstMap.locator('[title="stop:u-one"]')).toHaveCount(1);
  await expect(
    firstMap.locator('[title="stop:s-a"] [style*="background-color"]').first(),
  ).toHaveCSS("background-color", "rgb(8, 145, 178)");
  // Selection must move the actual Leaflet view, not merely update the
  // selected-stop state. Both selections originate in the opener timeline.
  for (const id of ["s-a", "u-one"]) {
    await page.locator(`[data-stop-id="${id}"]`).first().click();
    await expect.poll(async () => {
      const marker = await firstMap.locator(`[title="stop:${id}"]`).boundingBox();
      const map = await firstMap.locator(".leaflet-container").boundingBox();
      return marker && map ? Math.abs(marker.x + marker.width / 2 - (map.x + map.width / 2)) : 9999;
    }).toBeLessThan(45);
  }

  // A reload must retain the route-scoped URL. Then update the opener through
  // wouter's history listener, removing the highlight but retaining the plan.
  await firstMap.reload();
  await expect(firstMap).toHaveURL(/\/map-popout\?planId=plan-one&routeId=a$/);
  await firstMap.getByTestId("map-popout-counts").waitFor();
  await page.evaluate(() => {
    history.pushState({}, "", "/dispatch?view=traffic&planId=plan-one");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(page).toHaveURL(/\/dispatch\?view=traffic&planId=plan-one$/);
  await expect(firstMap).toHaveURL(/\/map-popout\?planId=plan-one$/);
  await expect(firstMap.getByTestId("map-popout-counts")).toHaveText(/2 .* · 1 /);
  await expect(firstMap.locator('[title="stop:s-b"]')).toHaveCount(1);
  await firstMap.screenshot({ path: "screenshots/map-popout-scoped.png" });

  // The opener can subsequently move to the default, unscoped traffic board;
  // cancelled/completed history remains excluded while only unassigned stops
  // from visible plans are shown, never the unowned organisation backlog.
  await page.getByTestId("dispatch-all-plans").click();
  await expect(page).toHaveURL(/\/dispatch\?view=traffic$/);
  await expect(firstMap).toHaveURL(/\/map-popout$/);
  await expect(firstMap.getByTestId("map-popout-counts")).toHaveText(/2 .* · 2 /);
  await expect(firstMap.locator('[title="stop:s-b"]')).toHaveCount(0);
  await expect(firstMap.locator('[title="stop:s-d"]')).toHaveCount(0);

  // A message with the right origin but the wrong source window must not
  // retarget the first map.
  await firstMap.evaluate(() => {
    window.dispatchEvent(new MessageEvent("message", {
      origin: window.location.origin,
      data: { type: "traivo-map-scope", search: "?planId=plan-two" },
      source: null,
    }));
  });
  await expect(firstMap).toHaveURL(/\/map-popout$/);

  // A second dispatch window owns a distinct map and cannot retarget the
  // first opener's map scope.
  const secondDispatch = await context.newPage();
  await secondDispatch.goto("/dispatch?view=traffic&planId=plan-two");
  const secondPopupPromise = secondDispatch.waitForEvent("popup");
  await secondDispatch.getByTestId("button-map-popout").click();
  const secondMap = await secondPopupPromise;
  expect(secondMap).not.toBe(firstMap);
  await expect(secondMap).toHaveURL(/\/map-popout\?planId=plan-two$/);
  await expect(secondMap.getByTestId("map-popout-counts")).toHaveText(/2 .* · 1 /);
  await expect(secondMap.locator('[title="stop:s-c"]')).toHaveCount(1);
  await expect(secondMap.locator('[title="stop:s-d"]')).toHaveCount(1);
  await expect(
    secondMap.locator('[title="stop:s-d"] [style*="background-color"]').first(),
  ).toHaveCSS("background-color", "rgb(124, 58, 237)");
  for (const id of ["s-a", "s-b", "s-legacy", "u-one", "u-legacy"]) {
    await expect(secondMap.locator(`[title="stop:${id}"]`)).toHaveCount(0);
  }
  await expect(firstMap).toHaveURL(/\/map-popout$/);
  await expect(firstMap.getByTestId("map-popout-counts")).toHaveText(/2 .* · 2 /);

  // The legacy dispatch entry point remains directly addressable and keeps
  // its completed route and stop visible for historical review.
  await secondMap.close();
  await secondDispatch.goto("/dispatch?view=traffic&routeId=legacy");
  const legacyPopupPromise = secondDispatch.waitForEvent("popup");
  await secondDispatch.getByTestId("button-map-popout").click();
  const legacyMap = await legacyPopupPromise;
  await expect(legacyMap).toHaveURL(/\/map-popout\?routeId=legacy$/);
  await expect(legacyMap.getByTestId("map-popout-counts")).toHaveText(/1 .* · 0 /);
  const legacyMarker = legacyMap.locator('[title="stop:s-legacy"]');
  await expect(legacyMarker).toHaveCount(1);
  await legacyMarker.click();
  await expect(legacyMap.getByText("Slutförd", { exact: true })).toBeVisible();

  const forbiddenRequests = requests.filter(
    ({ method, path }) =>
      method !== "GET" || /\/(?:dispatch|resend-sms|send-sms)(?:\/|$)/i.test(path),
  );
  expect(forbiddenRequests).toEqual([]);
  expect(requests.some(({ path }) => path === "/api/routes")).toBe(true);
  expect(requests.some(({ path }) => path === "/api/stops")).toBe(true);
  expect(requests.some(({ path }) => path === "/api/vehicles")).toBe(true);
  expect(requests.every(({ path }) => path.startsWith("/api/"))).toBe(true);

  await legacyMap.close();
  await firstMap.close();
  await secondDispatch.close();
});
}