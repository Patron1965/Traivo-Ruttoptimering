import { expect, type BrowserContext, type Page, type Request } from "@playwright/test";
import { authenticatedOrganizationId, login, test } from "./auth";

type Layout = "map" | "split" | "timeline";

// Authentication and all reads use the real API in auth.ts's disposable tenant.
// No routes are dispatched, no drivers have recipients, and unexpected writes
// are blocked rather than risking a notification while exercising the UI.
async function guardReadOnly(context: BrowserContext) {
  const writes: string[] = [];
  const errors: string[] = [];
  const watch = (page: Page) => page.on("pageerror", error => errors.push(error.message));
  context.pages().forEach(watch);
  context.on("page", watch);
  await context.route("**/api/**", async route => {
    const request = route.request();
    if (!["GET", "HEAD", "OPTIONS"].includes(request.method())) {
      writes.push(`${request.method()} ${new URL(request.url()).pathname}`);
      await route.fulfill({ status: 403, json: { error: "Read-only regression test" } });
    } else {
      await route.continue();
    }
  });
  return { writes, errors };
}

async function expectLayout(page: Page, layout: Layout) {
  await expect(page.getByTestId(`button-layout-${layout}`)).toHaveAttribute("aria-checked", "true");
  await expect(page.getByTestId("dispatch-split")).toBeVisible();
  for (const [id, visible] of [
    ["dispatch-map-panel", layout !== "timeline"],
    ["dispatch-timeline-panel", layout !== "map"],
    ["dispatch-split-handle", layout === "split"],
  ] as const) {
    const panel = page.getByTestId(id);
    if (visible) {
      await expect(panel).toBeVisible();
      const bounds = await panel.boundingBox();
      expect(bounds!.height).toBeGreaterThan(0);
      expect(bounds!.width).toBeGreaterThan(0);
    } else {
      await expect(panel).toHaveCount(0);
    }
  }
  if (layout !== "timeline") await expect(page.locator(".leaflet-container")).toBeVisible();
}

for (const viewport of [{ width: 1024, height: 768 }, { width: 1440, height: 1000 }]) {
  test(`traffic layouts survive switching, reload and planning popout (${viewport.width})`, async ({ page, context }) => {
    await page.setViewportSize(viewport);
    await login(page, "/dispatch?view=traffic&layout=map", "traffic-layout-switch");
    const safety = await guardReadOnly(context);

    // The single-panel -> split transition previously crashed panel registration.
    // Test both directions, including remounting the map after timeline-only.
    for (const layout of ["map", "split", "timeline", "split", "map"] as const) {
      await page.getByTestId(`button-layout-${layout}`).click();
      await expectLayout(page, layout);
      await expect(page).toHaveURL(new RegExp(`[?&]layout=${layout}(?:&|$)`));

      // Prove URL authority, not just persistence of the same localStorage value.
      await page.evaluate(value => localStorage.setItem("traffic.layout", value),
        layout === "map" ? "timeline" : "map");
      await page.reload();
      await expectLayout(page, layout);
    }

    await page.getByTestId("button-layout-split").click();
    await expectLayout(page, "split");
    const popupPromise = page.waitForEvent("popup");
    await page.getByTestId("button-map-popout").click();
    const planningMap = await popupPromise;
    await expect(planningMap).toHaveURL(/\/map-popout$/);
    await expect(planningMap.getByTestId("map-popout-counts")).toBeVisible();
    await expect(planningMap.locator(".leaflet-container")).toBeVisible();
    await expect(planningMap.getByTestId("live-map-popout")).toHaveCount(0);
    await expect(page.getByTestId("dispatch-map-panel")).toHaveCount(0);
    await expect(page.getByTestId("dispatch-timeline-panel")).toBeVisible();
    await planningMap.reload();
    await expect(planningMap.getByTestId("map-popout-counts")).toBeVisible();
    await planningMap.close();
    await expectLayout(page, "split");
    await page.getByTestId("button-layout-timeline").click();
    await expectLayout(page, "timeline");
    await page.getByTestId("button-layout-split").click();
    await expectLayout(page, "split");
    expect(safety.writes).toEqual([]);
    expect(safety.errors).toEqual([]);
  });
}

test("standalone live map keeps polling after its opener closes and after reload", async ({ page, context }) => {
  test.setTimeout(90_000);
  await login(page, "/dispatch?view=traffic&layout=split", "traffic-layout-switch");
  const organizationId = await authenticatedOrganizationId(page);
  const safety = await guardReadOnly(context);
  const popupPromise = page.waitForEvent("popup");
  await page.getByTestId("button-open-live-map").click();
  const liveMap = await popupPromise;
  await expect(liveMap).toHaveURL(/\/map-popout\?live=1$/);
  await expect(liveMap.getByTestId("live-map-popout")).toBeVisible();
  await expect(liveMap.getByTestId("text-live-counts")).toContainText("0 rutter");
  await expect(liveMap.locator(".leaflet-container")).toBeVisible();
  await page.close();

  const paths = ["/api/vehicles/positions", "/api/geofence/events", "/api/routes", "/api/stops"];
  // Observe successful real responses from this window only. An initial fetch,
  // a stale cached render or requests made by the opener cannot satisfy this.
  const responses: Array<{ path: string; organizationId: string | null }> = [];
  const startedRequests = new Set<Request>();
  liveMap.on("request", request => startedRequests.add(request));
  liveMap.on("response", response => {
    const url = new URL(response.url());
    if (startedRequests.has(response.request()) && response.ok() && paths.includes(url.pathname)) {
      responses.push({ path: url.pathname, organizationId: url.searchParams.get("organizationId") });
    }
  });
  async function expectContinuedPolling() {
    responses.length = 0;
    startedRequests.clear();
    await expect.poll(() => paths.every(path =>
      responses.filter(item => item.path === path).length >= (path === paths[0] ? 2 : 1)),
    { timeout: 30_000, intervals: [500] }).toBe(true);
    for (const response of responses) {
      if (response.path === paths[0] || response.path === paths[1]) {
        expect(response.organizationId).toBe(organizationId);
      }
    }
    await expect(liveMap.getByTestId("text-live-counts")).toContainText("0 rutter");
    expect(safety.errors).toEqual([]);
    expect(safety.writes).toEqual([]);
  }
  await expectContinuedPolling();
  await liveMap.reload();
  await expect(liveMap.getByTestId("live-map-popout")).toBeVisible();
  await expect(liveMap).toHaveURL(/\/map-popout\?live=1$/);
  await expectContinuedPolling();
  await liveMap.close();
});
