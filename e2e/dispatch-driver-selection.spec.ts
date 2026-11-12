import { expect, test, type Page } from "@playwright/test";

function encodePolyline(points: number[][]): string {
  let latitude = 0, longitude = 0;
  const encode = (delta: number) => {
    let value = delta < 0 ? ~(delta << 1) : delta << 1;
    let result = "";
    while (value >= 0x20) {
      result += String.fromCharCode((0x20 | (value & 0x1f)) + 63);
      value >>= 5;
    }
    return result + String.fromCharCode(value + 63);
  };
  return points.map(([lat, lng]) => {
    const nextLat = Math.round(lat * 1e5), nextLng = Math.round(lng * 1e5);
    const result = encode(nextLat - latitude) + encode(nextLng - longitude);
    latitude = nextLat;
    longitude = nextLng;
    return result;
  }).join("");
}

for (const geometry of ["fallback", "road"] as const) {
test(`driver selection supports overlapping ${geometry} routes, clear, additive rows and isolated windows`, async ({ page, context }) => {
  test.setTimeout(90000);
  const names = ["Ajmel", "Alex", "Dan", "David"];
  let removed = false;
  const routes = names.map((name, index) => ({
    id: `r${index}`, planId: index === 3 ? "plan-two" : "plan-one",
    name: `Plan · ${name}`, status: "optimized", vehicleId: `v${index}`,
    driverId: `d${index}`, date: "2026-10-07", organizationId: "fixture",
    createdAt: "2026-10-07T06:00:00Z", updatedAt: "2026-10-07T06:00:00Z",
    planRevision: 0, totalStops: 1, totalDistanceKm: 12, totalDurationMin: 30,
    depotSnapshot: { start: { latitude: 59.3, longitude: 18.1 }, end: { latitude: 59.3, longitude: 18.1 } },
  }));
  const stops = routes.map((route, index) => ({
    id: `s${index}`, routeId: route.id, planningPlanId: route.planId, organizationId: "fixture",
    // r0 and r1 have completely overlapping geometry (including both depot legs).
    address: `Testgatan ${index + 1}`, latitude: [59.32, 59.32, 59.32, 59.32][index],
    longitude: [18.07, 18.07, 18.15, 18.08][index], sequenceOrder: 1, status: "pending", serviceDuration: 5,
  }));
  const vehicles = routes.map((route, index) => ({
    id: route.vehicleId, name: `Bil ${index}`, licensePlate: `ABC00${index}`,
    routeColor: ["#0891B2", "#059669", "#D97706", "#7C3AED"][index],
    vehicleType: "fossil", isActive: true,
  }));
  const drivers = names.map((name, index) => ({
    id: `d${index}`, name, vehicleId: `v${index}`, isActive: true, organizationId: "fixture",
  }));
  const writes: string[] = [];
  const errors: string[] = [];
  context.on("page", (opened) => opened.on("pageerror", (error) => errors.push(error.message)));
  page.on("pageerror", (error) => errors.push(error.message));
  await context.route("**/api/**", async (request) => {
    const url = new URL(request.request().url());
    const path = url.pathname;
    if (request.request().method() !== "GET") writes.push(path);
    let body: unknown = [];
    if (path.endsWith("/auth/me")) body = {
      user: { id: "fixture-user", name: "Selection test", email: "selection@example.test",
        role: "admin", organizationId: "fixture", driverProfileId: null }, session: null,
    };
    else if (path === "/api/routes") body = routes.filter((r) => !removed || r.id !== "r2");
    else if (path === "/api/stops") body = stops;
    else if (path === "/api/drivers") body = drivers;
    else if (path === "/api/vehicles") body = vehicles;
    else if (/^\/api\/routes\/[^/]+\/stops$/.test(path)) body = stops.filter((s) => s.routeId === path.split("/")[3]);
    else if (/^\/api\/routes\/[^/]+$/.test(path)) body = routes.find((r) => r.id === path.split("/")[3]) ?? null;
    else if (path.includes("/osrm/route")) {
      const points = (url.searchParams.get("coords") ?? "").split(";").map((coordinate) => {
        const [lng, lat] = coordinate.split(",").map(Number);
        return [lat, lng];
      });
      // A bent road fixture, identical for r0/r1 and distinct from fallback legs.
      const roadPoints = points.flatMap((point, index) => index === 0 ? [point] : [
        [(points[index - 1][0] + point[0]) / 2 + 0.001,
          (points[index - 1][1] + point[1]) / 2], point,
      ]);
      body = { code: "Ok", routes: [{ geometry: geometry === "road" ? encodePolyline(roadPoints) : "" }] };
    }
    await request.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  const checkbox = (target: Page, id: string) => target.getByTestId(`dispatch-driver-select-${id}`);
  const row = (target: Page, id: string) => target.locator(`[data-route-label-id="${id}"]`);
  const selectRow = (target: Page, id: string, additive = false) =>
    row(target, id).click({ position: { x: 6, y: 28 }, modifiers: additive ? ["Shift"] : [] });
  const checked = async (target: Page, ids: string[]) => {
    for (const id of ["r0", "r1", "r2"]) {
      if (ids.includes(id)) await expect(checkbox(target, id)).toBeChecked();
      else await expect(checkbox(target, id)).not.toBeChecked();
    }
  };
  const clickLine = async (target: Page, id: string, modifier?: "Shift" | "Control" | "Meta", choose = true) => {
    const line = target.locator(`path.map-route-hit-${id}`);
    await expect(line).toBeAttached();
    await expect(target.locator(".leaflet-pan-anim")).toHaveCount(0);
    // Real pointer input at a point on the line, away from stop/depot markers.
    const point = await line.evaluate((element) => {
      const path = element as SVGPathElement;
      const local = path.getPointAtLength(path.getTotalLength() * 0.2);
      const screen = new DOMPoint(local.x, local.y).matrixTransform(path.getScreenCTM()!);
      return { x: screen.x, y: screen.y };
    });
    if (modifier) await target.keyboard.down(modifier);
    try { await target.mouse.click(point.x, point.y); }
    finally { if (modifier) await target.keyboard.up(modifier); }
    if (id === "r0" || id === "r1") {
      const choices = target.getByTestId("map-route-choices");
      await expect(choices).toBeVisible();
      await expect(choices.getByTestId("map-route-choice-r0")).toBeVisible();
      await expect(choices.getByTestId("map-route-choice-r1")).toBeVisible();
      await expect(choices.getByTestId("map-route-choice-r2")).toHaveCount(0);
      if (choose) {
        // Release the modifier BEFORE choosing: the map click's intent survives.
        await target.getByTestId(`map-route-choice-${id}`).click();
        await expect(choices).toHaveCount(0);
      }
    } else {
      await expect(target.getByTestId("map-route-choices")).toHaveCount(0);
    }
  };
  const openMapSelection = async (target: Page) => {
    const summary = target.getByText(/^Välj chaufförer \(\d+\)$/);
    await summary.focus();
    await target.keyboard.press("Enter");
  };

  await page.goto("/dispatch?view=traffic&planId=plan-one");
  await expect(checkbox(page, "r0")).toBeVisible();
  if (geometry === "road") await expect(page.locator('path[stroke="#ffffff"]')).toHaveCount(3);
  await expect(page.getByTestId("dispatch-clear-drivers")).toBeDisabled();
  await selectRow(page, "r0");
  await selectRow(page, "r2", true);
  await checked(page, ["r0", "r2"]);
  await expect(row(page, "r0")).not.toHaveClass(/opacity-60/);
  await expect(row(page, "r2")).not.toHaveClass(/opacity-60/);
  await selectRow(page, "r1", true);
  await checked(page, ["r0", "r1", "r2"]);
  await selectRow(page, "r1", true);
  await checked(page, ["r0", "r2"]);
  await selectRow(page, "r1");
  await checked(page, ["r1"]);

  // Keyboard-accessible checkboxes toggle independently of normal row selection.
  await checkbox(page, "r2").focus();
  await page.keyboard.press("Space");
  await checked(page, ["r1", "r2"]);

  // An ambiguous click never changes selection before the dispatcher chooses.
  await clickLine(page, "r0", undefined, false);
  await checked(page, ["r1", "r2"]);
  await expect(page.getByTestId("map-route-choice-r0")).toBeFocused();
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("map-route-choices")).toHaveCount(0);
  await checked(page, ["r1", "r2"]);
  await clickLine(page, "r0", "Shift", false);
  await page.getByTestId("map-route-choice-r0").focus();
  await page.keyboard.press("Enter");
  await checked(page, ["r0", "r1", "r2"]);

  // The embedded map uses the same pointer and keyboard controls.
  await clickLine(page, "r0");
  await clickLine(page, "r2", "Shift");
  await checked(page, ["r0", "r2"]);
  await clickLine(page, "r0", "Control");
  await checked(page, ["r2"]);
  await openMapSelection(page);
  await page.getByTestId("map-driver-select-r1").focus();
  await page.keyboard.press("Space");
  await checked(page, ["r1", "r2"]);
  await openMapSelection(page);
  // Area marking belongs to stops, not the visual driver selection.
  await page.getByTestId("dispatch-mark-stops").click();
  await expect(page.locator("path[class*='map-route-hit-']")).toHaveCount(0);
  await expect(page.getByText(/^Välj chaufförer/)).toHaveCount(0);
  await page.getByTestId("dispatch-cancel-marking").click();
  await checked(page, ["r1", "r2"]);

  await page.locator('[data-timeline-route-id="r1"]').getByTestId("dispatch-stop-block").first().click();
  await expect(page.getByTestId("dispatch-selected-count")).toHaveText("1 markerade stopp");
  await selectRow(page, "r1");
  await selectRow(page, "r2", true);
  await checked(page, ["r1", "r2"]);
  // Escape owns only the active map marking, including a zero-corner draft.
  const markingButton = page.getByTestId("dispatch-mark-stops");
  for (const corners of [0, 1, 2]) {
    await markingButton.click();
    await expect(page.getByTestId("dispatch-cancel-marking")).toBeVisible();
    const mapBounds = await page.locator(".leaflet-container").boundingBox();
    expect(mapBounds).not.toBeNull();
    for (let index = 0; index < corners; index++) {
      await page.mouse.click(
        mapBounds!.x + mapBounds!.width * (0.4 + index * 0.15),
        mapBounds!.y + mapBounds!.height * 0.65,
      );
    }
    await page.keyboard.press("Escape");
    await expect(markingButton).toHaveAttribute("aria-pressed", "false");
    await checked(page, ["r1", "r2"]);
    await expect(page.getByTestId("dispatch-selected-count")).toHaveText("1 markerade stopp");
    await expect(page.getByTestId("dispatch-stop-detail-panel")).toBeVisible();
  }
  // The button cancellation has the same preservation contract.
  await markingButton.click();
  await page.getByTestId("dispatch-cancel-marking").click();
  await checked(page, ["r1", "r2"]);
  await expect(page.getByTestId("dispatch-selected-count")).toHaveText("1 markerade stopp");
  // Outside marking, retain the existing priority: close details, then clear.
  await page.keyboard.press("Escape");
  await expect(page.getByTestId("dispatch-stop-detail-panel")).toHaveCount(0);
  await checked(page, ["r1", "r2"]);
  await expect(page.getByTestId("dispatch-selected-count")).toHaveText("1 markerade stopp");
  await page.keyboard.press("Escape");
  await checked(page, []);
  await expect(page.getByTestId("dispatch-selected-count")).toHaveCount(0);
  // Reset the stop-focused map viewport before the existing popout checks.
  await page.reload();
  await expect(checkbox(page, "r1")).toBeVisible();
  await selectRow(page, "r1");
  await selectRow(page, "r2", true);
  await checked(page, ["r1", "r2"]);

  const mapPromise = page.waitForEvent("popup");
  await page.getByTestId("button-map-popout").click();
  const map = await mapPromise;
  // The map deliberately preserves marker visibility; selected route lines
  // (not marker dimming) expose the multi-highlight for fallback geometry.
  await expect(map.locator('path[stroke="#059669"]')).toHaveAttribute("stroke-opacity", "1");
  await expect(map.locator('path[stroke="#D97706"]')).toHaveAttribute("stroke-opacity", "1");
  if (geometry === "fallback") await expect(map.locator('path[stroke="#0891B2"]')).toHaveCount(0);
  else {
    // Popout deliberately preserves visibility; thickness distinguishes selection.
    await expect(map.locator('path[stroke="#0891B2"]')).toHaveAttribute("stroke-width", "5");
    await expect(map.locator('path[stroke="#059669"]')).toHaveAttribute("stroke-width", "6");
    await expect(map.locator('path[stroke="#D97706"]')).toHaveAttribute("stroke-width", "6");
  }
  await expect(map.locator('[title="stop:s1"]')).not.toHaveClass(/dimmed/);
  await expect(map.locator('[title="stop:s2"]')).not.toHaveClass(/dimmed/);
  await map.reload();
  await expect(map.locator('path[stroke="#059669"]')).toHaveAttribute("stroke-opacity", "1");
  await expect(map.locator('path[stroke="#D97706"]')).toHaveAttribute("stroke-opacity", "1");
  await expect(map.locator('[title="stop:s2"]')).not.toHaveClass(/dimmed/);

  // Route lines are the same visual selection control in both windows.
  await clickLine(map, "r0");
  await checked(page, ["r0"]);
  await clickLine(map, "r2", "Shift");
  await checked(page, ["r0", "r2"]);
  await clickLine(map, "r1", "Control");
  await checked(page, ["r0", "r1", "r2"]);
  await clickLine(map, "r1", "Meta");
  await checked(page, ["r0", "r2"]);
  await clickLine(map, "r0", "Shift");
  await checked(page, ["r2"]);
  await clickLine(map, "r2", "Control");
  await checked(page, []);
  await selectRow(page, "r0");
  await selectRow(page, "r2", true);
  await checked(page, ["r0", "r2"]);
  await expect(map.locator('path[stroke="#0891B2"]')).toHaveAttribute("stroke-opacity", "1");
  await expect(map.locator('path[stroke="#D97706"]')).toHaveAttribute("stroke-opacity", "1");

  // Keyboard equivalent in the popup supports independent toggle and clear.
  await openMapSelection(map);
  await map.getByTestId("map-driver-select-r1").focus();
  await map.keyboard.press("Space");
  await checked(page, ["r0", "r1", "r2"]);
  await map.keyboard.press("Space");
  await checked(page, ["r0", "r2"]);
  await map.getByTestId("map-clear-drivers").focus();
  await map.keyboard.press("Enter");
  await checked(page, []);
  await openMapSelection(map);

  // Select a stop, then clear only drivers.
  await page.locator('[data-timeline-route-id="r1"]').getByTestId("dispatch-stop-block").first().click();
  await expect(page.getByTestId("dispatch-selected-count")).toHaveText("1 markerade stopp");
  // Stop selection now focuses/zooms the map. Other routes can be offscreen:
  // use the popup's driver controls for this stop-selection preservation check.
  // Real route-line pointer selection is covered above at the overview extent.
  await openMapSelection(map);
  await map.getByTestId("map-driver-select-r1").uncheck();
  await map.getByTestId("map-driver-select-r0").check();
  await map.getByTestId("map-driver-select-r2").check();
  await checked(page, ["r0", "r2"]);
  await expect(page.getByTestId("dispatch-selected-count")).toHaveText("1 markerade stopp");
  await page.getByTestId("dispatch-clear-drivers").click();
  await checked(page, []);
  await expect(page.getByTestId("dispatch-selected-count")).toHaveText("1 markerade stopp");
  await expect(map.locator('[title="stop:s0"]')).not.toHaveClass(/dimmed/);
  await expect(map.locator('[title="stop:s2"]')).not.toHaveClass(/dimmed/);
  if (geometry === "fallback") {
    await expect(map.locator('path[stroke="#059669"]')).toHaveCount(0);
    await expect(map.locator('path[stroke="#D97706"]')).toHaveCount(0);
  } else {
    await expect(map.locator('path[stroke="#059669"]')).toHaveAttribute("stroke-opacity", "1");
    await expect(map.locator('path[stroke="#D97706"]')).toHaveAttribute("stroke-opacity", "1");
  }

  // Selected route removed by a read refresh is pruned, not silently substituted.
  await selectRow(page, "r0");
  await selectRow(page, "r2", true);
  removed = true;
  await expect(checkbox(page, "r2")).toHaveCount(0, { timeout: 20000 });
  await expect(checkbox(page, "r0")).toBeChecked();
  removed = false;
  await expect(checkbox(page, "r2")).toBeVisible({ timeout: 20000 });
  await expect(checkbox(page, "r2")).not.toBeChecked();

  const timelinePromise = page.waitForEvent("popup");
  await page.getByTestId("button-gantt-popout").click();
  const timeline = await timelinePromise;
  await expect(checkbox(timeline, "r0")).toBeVisible();
  await selectRow(timeline, "r0");
  await selectRow(timeline, "r2", true);
  await checked(timeline, ["r0", "r2"]);
  await timeline.getByTestId("dispatch-clear-drivers").click();
  await checked(timeline, []);
  await expect(checkbox(page, "r0")).toBeChecked();

  // Even another main window for the SAME plan must not share this pair's selection.
  const samePlan = await context.newPage();
  await samePlan.goto("/dispatch?view=traffic&planId=plan-one");
  await expect(checkbox(samePlan, "r0")).toBeVisible();
  const sameMapPromise = samePlan.waitForEvent("popup");
  await samePlan.getByTestId("button-map-popout").click();
  const sameMap = await sameMapPromise;
  await clickLine(sameMap, "r0", undefined, false);
  await checked(samePlan, []);
  await checked(page, ["r0"]);
  await expect(map.getByTestId("map-route-choices")).toHaveCount(0);
  await sameMap.getByTestId("map-route-choices").getByRole("button", { name: "Avbryt" }).click();
  await clickLine(sameMap, "r1");
  await checked(samePlan, ["r1"]);
  await clickLine(map, "r2", "Shift");
  await checked(page, ["r0", "r2"]);
  await checked(samePlan, ["r1"]);
  await checked(timeline, []);
  await samePlan.evaluate(() => {
    const main = window;
    // An unrelated same-origin sender cannot forge a popup selection.
    main.postMessage({ channel: "traivo-dispatch-map", message: {
      type: "route-selection", from: "popout", routeIds: ["r0"],
      scopeKey: JSON.stringify(["fixture:fixture-user", "plan-one", null]),
    } }, main.location.origin);
  });
  await checked(samePlan, ["r1"]);

  const other = await context.newPage();
  await other.goto("/dispatch?view=traffic&planId=plan-two");
  await expect(checkbox(other, "r3")).toBeVisible();
  await selectRow(other, "r3");
  await expect(checkbox(page, "r0")).toBeChecked();
  await expect(checkbox(timeline, "r0")).not.toBeChecked();
  await expect(map.locator('[title="stop:s3"]')).toHaveCount(0);
  const otherMapPromise = other.waitForEvent("popup");
  await other.getByTestId("button-map-popout").click();
  const otherMap = await otherMapPromise;
  await clickLine(otherMap, "r3", "Shift");
  await expect(checkbox(other, "r3")).not.toBeChecked();
  await checked(page, ["r0", "r2"]);
  await checked(samePlan, ["r1"]);
  await page.screenshot({ path: "screenshots/dispatch-driver-selection.png" });

  // Switching scope clears old driver selections; changing view is not a scope change.
  await clickLine(map, "r0", undefined, false);
  await page.evaluate(() => {
    history.pushState({}, "", "/dispatch?view=traffic&planId=plan-two");
    window.dispatchEvent(new PopStateEvent("popstate"));
  });
  await expect(checkbox(page, "r3")).toBeVisible();
  await expect(checkbox(page, "r3")).not.toBeChecked();
  await expect(map.getByTestId("map-route-choices")).toHaveCount(0);
  await expect(page.getByTestId("dispatch-clear-drivers")).toBeDisabled();
  await expect(timeline.getByTestId("dispatch-driver-select-r3")).toBeVisible();
  await expect(timeline.getByTestId("dispatch-driver-select-r3")).not.toBeChecked();
  expect(writes).toEqual([]);
  expect(errors).toEqual([]);
  await sameMap.close();
  await samePlan.close();
  await otherMap.close();
  await other.close();
  await timeline.close();
  await map.close();
});
}
