import { expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { authenticatedOrganizationId, login, test } from "./auth";

// UI-contract evidence, NOT backend move/append persistence evidence.
// Real disposable-tenant authentication and permission checks; operational
// mutations are intercepted, with an in-memory server model surviving reload.
test.setTimeout(90_000);
const digest = "a".repeat(64);

async function policy(organizationId: string, districtEnabled: boolean) {
  await promisify(execFile)("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
    import { pool } from "@workspace/db";
    (async () => {
      try {
        const owned = await pool.query("SELECT id FROM organizations WHERE id=$1 AND email LIKE 'e2e-address-persistence-%@example.test'", [process.env.E2E_ORG]);
        if (owned.rowCount !== 1) throw new Error("Not a disposable fixture");
        await pool.query("INSERT INTO organization_service_policies (organization_id,policy) VALUES ($1,$2::jsonb) ON CONFLICT (organization_id) DO UPDATE SET policy=EXCLUDED.policy, revision=organization_service_policies.revision+1",
          [process.env.E2E_ORG, JSON.stringify({roadProvider:"disabled",geocodingProvider:"disabled",smsProvider:"disabled",emailEnabled:false,aiEnabled:false,cuoptEnabled:false,districtEnabled:${districtEnabled}})]);
      } finally { await pool.end(); }
    })().catch(e => { console.error(e); process.exitCode=1; });
  `], { env: { ...process.env, E2E_ORG: organizationId } });
}

async function setup(page: Page) {
  await page.setViewportSize({ width: 1440, height: 1100 });
  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);
  await policy(organizationId, false);
  const create = async (path: string, data: object) => {
    const response = await page.request.post(`/api/${path}`, { data: { organizationId, ...data } });
    expect(response.status(), await response.text()).toBe(201);
    return response.json();
  };
  const routes: any[] = [], stops: any[] = [], drivers: any[] = [];
  for (let i = 0; i < 2; i++) {
    const vehicle = await create("vehicles", { name: `Focused vehicle ${i}`, licensePlate: `FOCUS-${Date.now()}-${i}`, vehicleType: "fossil", capacityKg: 1000, capacityVolume: 10, isActive: true });
    const driver = await create("drivers", { name: `Focused driver ${i}`, vehicleId: vehicle.id, isActive: true });
    drivers.push(driver);
    // Route POST correctly requires enabled road service, even for an empty
    // route. Seed canonical DB fixtures instead; do not relax provider policy.
    const seeded = await promisify(execFile)("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
      import { db, pool, routesTable, stopsTable } from "@workspace/db";
      (async () => {
        try {
          const owned = await pool.query("SELECT id FROM organizations WHERE id=$1 AND email LIKE 'e2e-address-persistence-%@example.test'", [process.env.E2E_ORG]);
          if (owned.rowCount !== 1) throw new Error("Not a disposable fixture");
          const [route] = await db.insert(routesTable).values({
            organizationId: process.env.E2E_ORG, vehicleId: process.env.E2E_VEHICLE,
            // Legacy route recipient evidence must be explicit. Vehicle
            // linkage alone is intentionally insufficient for polygon moves.
            handoffDriverId: process.env.E2E_DRIVER,
            name: "Focused route ${i}",
            date: new Date(), status: "optimized", planRevision: 1, manualReviewRequired: false, totalStops: 1
          }).returning();
          const [stop] = await db.insert(stopsTable).values({
            organizationId: process.env.E2E_ORG, routeId: route.id,
            address: "Synthetic focused stop ${i}", latitude: ${59.3293 + i * .001},
            longitude: ${18.0686 + i * .001}, jobType: "delivery",
            serviceDurationMin: 15, sequenceOrder: 1, planningPlanId: route.planId
          }).returning();
          console.log(JSON.stringify({route, stop}));
        } finally { await pool.end(); }
      })().catch(e => { console.error(e); process.exitCode=1; });
    `], { env: { ...process.env, E2E_ORG: organizationId, E2E_VEHICLE: vehicle.id, E2E_DRIVER: driver.id } });
    const { route, stop } = JSON.parse(seeded.stdout.trim());
    routes.push(route);
    stops.push(stop);
  }
  const requests: { path: string; body: any }[] = [];
  let conflict = false;
  await page.route("**/api/**", async intercepted => {
    const request = intercepted.request();
    const path = new URL(request.url()).pathname;
    const fulfill = (body: unknown, status = 200) => intercepted.fulfill({ status, json: body });
    if (request.method() === "GET") {
      if (path === "/api/routes") return fulfill(routes);
      if (path === "/api/stops") return fulfill(stops);
      if (path === "/api/drivers") return fulfill(drivers);
      const routeStops = routes.find(r => path === `/api/routes/${r.id}/stops`);
      if (routeStops) return fulfill(stops.filter(s => s.routeId === routeStops.id));
      const route = routes.find(r => path === `/api/routes/${r.id}`);
      if (route) return fulfill(route);
      return intercepted.continue();
    }
    requests.push({ path, body: request.postDataJSON() });
    if (path === "/api/stops/dispatch-move/preview") return fulfill({
      canMove: !conflict, conflicts: conflict ? ["capacity_exceeded"] : [],
      targetStopCount: 2, previewDigest: digest,
    });
    if (path === "/api/stops/dispatch-move") {
      const body = request.postDataJSON();
      for (const id of body.stopIds) Object.assign(stops.find(s => s.id === id), { routeId: body.routeId, sequenceOrder: 2 });
      for (const route of routes) route.totalStops = stops.filter(s => s.routeId === route.id).length;
      return fulfill({ conflicts: [] });
    }
    if (path.endsWith("/import-stops/preview")) return fulfill({
      routeId: routes[0].id, planRevision: 1, proposalId: "focused-ui-proposal", digest,
      counts: { existing: 1, added: 1, received: 1, total: 2 }, duplicates: [],
      expiresAt: new Date(Date.now() + 600_000).toISOString(),
      consequences: { totalDistanceKm: 3, totalDurationMin: 30 },
    });
    if (path.endsWith("/import-stops/apply")) {
      stops.push({ ...stops[0], id: "11111111-1111-4111-8111-111111111111", address: "Synthetic appended CSV stop", sequenceOrder: 2 });
      routes[0].totalStops = stops.filter(s => s.routeId === routes[0].id).length;
      return fulfill({ routeId: routes[0].id, addedStopIds: [stops.at(-1).id] });
    }
    // No geocoder, optimizer, notification, or other operational write can
    // escape this browser test. Fixture setup above uses only safe CRUD.
    return fulfill({ error: `Unexpected write blocked by focused UI fixture: ${path}` }, 503);
  });
  await page.reload();
  await expect(page.getByTestId("dispatch-gantt-row")).toHaveCount(2);
  return { organizationId, routes, stops, requests, setConflict: (value: boolean) => { conflict = value; } };
}

async function polygon(page: Page) {
  await page.getByTestId("dispatch-mark-stops").click();
  await expect(page.getByTestId("dispatch-finish-marking")).toBeDisabled();
  const map = page.getByTestId("dispatch-map-panel").locator(".leaflet-container");
  const bounds = await map.boundingBox();
  if (!bounds) throw new Error("Map is not measurable");
  // Click corners away from the upper-left drawing controls.
  for (const [x, y] of [[.03, .92], [.97, .92], [.97, .08], [.25, .03]]) {
    await map.click({ position: { x: bounds.width * x, y: bounds.height * y } });
  }
  await page.getByTestId("dispatch-finish-marking").click();
  await expect(page.getByTestId("dispatch-bulk-dialog")).toBeVisible();
}

async function dragStop(page: Page, stopId: string, routeId: string) {
  const source = page.locator(`[data-testid="dispatch-stop-block"][data-stop-id="${stopId}"]`);
  const target = page.locator(`[data-testid="dispatch-timeline-row"][data-timeline-route-id="${routeId}"]`);
  await source.scrollIntoViewIfNeeded();
  // Bringing a far-right recalculation stop into view scrolls the shared
  // timeline horizontally. Its full bounding box can then start offscreen;
  // the old b.x + 200 produced x=-89 in the recorded trace.
  const point = await target.evaluate((element, expectedRoute) => {
    const bounds = element.getBoundingClientRect();
    for (let y = Math.max(0, bounds.top) + 5; y < Math.min(innerHeight, bounds.bottom); y += 8) {
      for (let x = Math.max(0, bounds.left) + 5; x < Math.min(innerWidth, bounds.right); x += 20) {
        if (document.elementFromPoint(x, y)?.closest("[data-drop-route-id]")?.getAttribute("data-drop-route-id") === expectedRoute) return { x, y };
      }
    }
    return null;
  }, routeId);
  const a = await source.boundingBox();
  if (!a || !point) throw new Error("No visible, hit-tested drag endpoints");
  await source.dispatchEvent("mousedown", { button: 0, buttons: 1, clientX: a.x + a.width / 2, clientY: a.y + a.height / 2 });
  await page.mouse.move(point.x, point.y, { steps: 12 });
  await page.mouse.up();
}

test("polygon finish exposes unassign and exact existing-driver route optimization (mocked move API)", async ({ page }, info) => {
  const fixture = await setup(page);
  let releasePreview!: () => void;
  const heldPreview = new Promise<void>(resolve => { releasePreview = resolve; });
  const previews: any[] = [];
  await page.route("**/api/stops/dispatch-move/preview", async intercepted => {
    previews.push(intercepted.request().postDataJSON());
    const attempt = previews.length;
    if (attempt === 1) await heldPreview;
    if (attempt === 2) {
      await intercepted.fulfill({ status: 503, json: { code: "ROAD_DATA_UNAVAILABLE" } });
      return;
    }
    await intercepted.fulfill({ json: {
      canMove: true, conflicts: [], targetStopCount: 2, previewDigest: digest,
    } });
  });
  await polygon(page);
  await expect(page.getByTestId("dispatch-bulk-action-route")).toHaveText("Flytta till förare och optimera rutten");
  await expect(page.getByTestId("dispatch-bulk-action-date")).toHaveCount(0);
  await expect(page.getByTestId("dispatch-bulk-action-unassign")).toBeVisible();
  await expect(page.getByTestId("dispatch-bulk-route").locator(`option[value="${fixture.routes[1].id}"]`)).toBeAttached();
  await page.getByTestId("dispatch-bulk-route").selectOption(fixture.routes[1].id);
  const progress = page.getByTestId("dispatch-bulk-preview-progress");
  await expect(progress).toBeVisible();
  await expect(progress.locator("svg.animate-spin")).toBeVisible();
  await expect.poll(async () => {
    const elapsed = (await progress.innerText()).match(/Väntat (\d+) sekunder/);
    return Number(elapsed?.[1] ?? 0);
  }).toBeGreaterThanOrEqual(3);
  await expect(page.getByTestId("dispatch-bulk-confirm")).toBeDisabled();
  expect(fixture.requests.filter(r => r.path === "/api/stops/dispatch-move")).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("polygon-preview-pending-3s.png") });
  releasePreview();
  await expect(page.getByTestId("dispatch-bulk-confirm")).toBeEnabled();
  await expect(progress).toHaveCount(0);
  expect(previews[0]).toMatchObject({ routeId: fixture.routes[1].id, optimizeTargetRoute: true });
  await page.screenshot({ path: info.outputPath("polygon-preview-ready.png") });

  // A controlled HTTP failure on a different exact target exercises the
  // manual retry, without waiting 180 seconds or contacting any road service.
  await page.getByTestId("dispatch-bulk-route").selectOption(fixture.routes[0].id);
  await expect(page.getByTestId("dispatch-bulk-feasibility").getByRole("alert"))
    .toHaveText("Vägdata saknas för omoptimeringen. Ingenting har flyttats. Försök igen när vägtjänsten är tillgänglig.");
  await expect(page.getByTestId("dispatch-bulk-confirm")).toBeDisabled();
  expect(previews).toHaveLength(2);
  await page.screenshot({ path: info.outputPath("polygon-preview-error-retry.png") });
  await page.getByTestId("dispatch-bulk-feasibility").getByRole("button", { name: "Försök igen" }).click();
  await expect(page.getByTestId("dispatch-bulk-confirm")).toBeEnabled();
  expect(previews).toHaveLength(3);
  expect(previews[2]).toEqual(previews[1]);
  expect(fixture.requests.filter(r => r.path === "/api/stops/dispatch-move")).toHaveLength(0);
  await page.screenshot({ path: info.outputPath("polygon-preview-retry-ready.png") });
  await page.getByTestId("dispatch-bulk-confirm").click();
  await expect(page.getByTestId("dispatch-bulk-dialog")).toBeHidden();
  const commits = fixture.requests.filter(r => r.path === "/api/stops/dispatch-move");
  expect(commits).toHaveLength(1);
  expect(commits[0].body).toMatchObject({
    routeId: fixture.routes[0].id, optimizeTargetRoute: true, expectedPreviewDigest: digest, force: false,
  });
  expect([...commits[0].body.stopIds].sort()).toEqual(fixture.stops.map(s => s.id).sort());
  expect(commits[0].body.routeRevisions).toEqual(expect.arrayContaining(
    fixture.routes.map(route => ({ routeId: route.id, planRevision: 1 })),
  ));
  expect(fixture.stops.every(s => s.routeId === fixture.routes[0].id)).toBe(true);
  await page.screenshot({ path: info.outputPath("polygon-confirmed.png") });
});

test("direct drag preference persists; conflicting drag requires Swedish review (mocked preview)", async ({ page }, info) => {
  const fixture = await setup(page);
  await page.goto("/settings");
  const checkbox = page.getByTestId("checkbox-direct-stop-move");
  await expect(checkbox).not.toBeChecked();
  await checkbox.check();
  await page.reload();
  await expect(checkbox).toBeChecked();
  await page.goto("/dispatch");
  await page.getByTestId("dispatch-map-toggle").click();
  await dragStop(page, fixture.stops[0].id, fixture.routes[1].id);
  await expect.poll(() => fixture.requests.filter(r => r.path === "/api/stops/dispatch-move").length).toBe(1);
  expect(fixture.requests.find(r => r.path === "/api/stops/dispatch-move")?.body).toMatchObject({
    routeId: fixture.routes[1].id, force: false, expectedPreviewDigest: digest, optimizeTargetRoute: false,
  });
  await expect(page.getByTestId("dispatch-bulk-dialog")).toHaveCount(0);
  await expect(page.locator(`[data-timeline-route-id="${fixture.routes[1].id}"] [data-stop-id="${fixture.stops[0].id}"]`)).toBeVisible();
  await page.screenshot({ path: info.outputPath("direct-drag-saved-desktop.png") });
  fixture.setConflict(true);
  await dragStop(page, fixture.stops[0].id, fixture.routes[0].id);
  await expect(page.getByTestId("dispatch-bulk-dialog")).toBeVisible();
  await expect(page.getByText("Flytten behöver granskas. Urvalet finns kvar; ingen automatisk omprövning görs.")).toBeVisible();
  expect(fixture.requests.filter(r => r.path === "/api/stops/dispatch-move")).toHaveLength(1);
  await page.screenshot({ path: info.outputPath("direct-drag-conflict-desktop.png") });
});

test("CSV append previews and applies only selected route; mock server state survives browser reload", async ({ page }, info) => {
  const fixture = await setup(page);
  let sendRouteUpdate: (() => void) | undefined;
  await page.routeWebSocket("**/ws", socket => {
    sendRouteUpdate = () => socket.send(JSON.stringify({
      type: "data:route:updated", data: { id: fixture.routes[0].id },
    }));
  });
  await page.goto(`/routes/${fixture.routes[0].id}`);
  await page.getByRole("button", { name: "Importera fler stopp", exact: true }).click();
  const dialog = page.getByRole("dialog");
  await dialog.locator('input[type="file"]').setInputFiles({
    name: "synthetic-append.csv", mimeType: "text/csv",
    buffer: Buffer.from("Leveransadress;Referensnummer;Eget fält\nSynthetic appended CSV stop;UI-APPEND-1;bevarat\n"),
  });
  let invalidAddress = true;
  await page.route("**/import-stops/preview", async intercepted => {
    if (!invalidAddress) return intercepted.fallback();
    invalidAddress = false;
    await intercepted.fulfill({ status: 422, json: { message: "Adressen måste verifieras",
      details: { rowResults: [{ sourceRowNumber: 2, reasons: ["Adressen måste verifieras"] }] } } });
  });
  await dialog.getByRole("button", { name: "Validera adresser och förhandsgranska" }).click();
  await expect(dialog.getByRole("alert")).toContainText("måste verifieras");
  await dialog.locator("fieldset input").first().fill("Synthetic corrected CSV stop");
  // Polling changes the live route revision; the open import must keep its
  // captured revision and entered file/corrections instead of remounting.
  fixture.routes[0].planRevision++;
  await expect.poll(() => Boolean(sendRouteUpdate)).toBe(true);
  const refreshed = page.waitForResponse(response => response.request().method() === "GET"
    && new URL(response.url()).pathname === `/api/routes/${fixture.routes[0].id}`);
  sendRouteUpdate!();
  expect((await refreshed).status()).toBe(200);
  await expect(dialog.locator("fieldset input").first()).toHaveValue("Synthetic corrected CSV stop");
  await dialog.getByRole("button", { name: "Validera adresser och förhandsgranska" }).click();
  await expect(dialog).toContainText("1 befintliga + 1 nya = 2 stopp");
  const preview = fixture.requests.find(r => r.path.endsWith("/import-stops/preview"));
  expect(preview?.path).toBe(`/api/routes/${fixture.routes[0].id}/import-stops/preview`);
  expect(preview?.body.expectedRowCount).toBe(1);
  expect(fixture.requests.some(r => r.path.endsWith("/apply"))).toBe(false);
  await page.screenshot({ path: info.outputPath("append-preview-desktop.png") });
  await dialog.getByRole("button", { name: "Bekräfta import och optimera hela rutten" }).click();
  await expect(dialog).toContainText("Importen är sparad");
  expect(fixture.requests.find(r => r.path.endsWith("/import-stops/apply"))?.body).toMatchObject({ digest, proposalId: "focused-ui-proposal", planRevision: 1 });
  await page.reload();
  await expect(page.getByText("Synthetic appended CSV stop").first()).toBeVisible();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: info.outputPath("append-reloaded-mobile.png") });

  // Same operational case also checks the compact import disclosure. Draft
  // autosaves are UI-only mocks, not a second persistence claim.
  const draft = {
    id: randomUUID(), organizationId: fixture.organizationId, name: "Focused compact import",
    startAt: new Date().toISOString(), state: { step: 1, source: "import" },
    revision: 0, importedResult: null, planId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  await page.route(`**/api/planning-drafts/${draft.id}`, async intercepted => {
    if (intercepted.request().method() === "PUT") {
      const body = intercepted.request().postDataJSON();
      if (body.state) draft.state = body.state;
      draft.revision++;
    }
    await intercepted.fulfill({ json: draft });
  });
  await page.setViewportSize({ width: 1440, height: 1100 });
  await page.goto(`/routes/drafts/${draft.id}`);
  await page.getByTestId("import-file-input").setInputFiles({
    name: "compact.csv", mimeType: "text/csv",
    buffer: Buffer.from("Leveransadress;Latitud;Longitud\nSynthetic compact stop;59.3293;18.0686\n"),
  });
  const next = page.getByRole("button", { name: /^(Nästa|Next)$/ });
  await next.click();
  await expect(page.getByTestId("import-review-filters")).toBeVisible();
  await expect(next).toBeVisible();
  await page.getByTestId("import-info-menu").click();
  for (const category of ["overview", "stats", "limits", "help"]) {
    await expect(page.getByTestId(`import-info-toggle-${category}`)).not.toBeChecked();
  }
  await page.getByTestId("import-info-toggle-stats").check();
  await page.keyboard.press("Escape");
  await expect(next).toBeVisible();
  await page.screenshot({ path: info.outputPath("compact-import-desktop.png") });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByTestId("import-info-menu").click();
  await page.getByTestId("import-info-toggle-stats").uncheck();
  await page.keyboard.press("Escape");
  await expect(next).toBeVisible();
  await page.screenshot({ path: info.outputPath("compact-import-mobile.png") });
});

test("compact import render only: long review at desktop/mobile and embedded Dispatch", async ({ page }, info) => {
  await page.setViewportSize({ width: 1024, height: 768 });
  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);
  const draft = {
    id: randomUUID(), organizationId, name: "Synthetic compact review",
    startAt: new Date().toISOString(), state: { step: 1, source: "import" } as Record<string, any>,
    revision: 0, importedResult: null, planId: null,
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
  };
  const blockedWrites: string[] = [];
  await page.route("**/api/**", async intercepted => {
    const request = intercepted.request();
    const path = new URL(request.url()).pathname;
    if (path === `/api/planning-drafts/${draft.id}`) {
      if (request.method() === "PUT") {
        const body = request.postDataJSON();
        if (body.state) draft.state = body.state;
        draft.revision++;
      }
      return intercepted.fulfill({ json: draft });
    }
    if (request.method() !== "GET" || /geocode|optimiz|dispatch-move/.test(path)) {
      blockedWrites.push(`${request.method()} ${path}`);
      return intercepted.fulfill({ status: 503, json: { error: "Read-only visual fixture blocks operational requests" } });
    }
    return intercepted.continue();
  });
  await page.goto(`/routes/drafts/${draft.id}`);
  await page.getByTestId("import-file-input").setInputFiles({
    name: "synthetic-long-review.csv", mimeType: "text/csv",
    buffer: Buffer.from("Leveransadress;Latitud;Longitud\n" + Array.from({ length: 100 }, (_, i) =>
      `Synthetic visual row ${i + 1};59.3293;18.0686`).join("\n")),
  });
  await page.getByRole("button", { name: /^(Nästa|Next)$/ }).click();
  await expect(page.getByTestId("import-review-filters")).toBeVisible();
  await page.getByTestId("import-review-filter-all").click();
  const measurements: Record<string, unknown>[] = [];
  async function capture(label: string, width: number, height: number) {
    await page.setViewportSize({ width, height });
    // Explicitly return every scroll container to its initial position.
    // No scrollIntoView call is used to make the action assertion pass.
    await page.evaluate(() => {
      window.scrollTo(0, 0);
      for (const element of document.querySelectorAll<HTMLElement>("*")) {
        if (element.scrollTop) element.scrollTop = 0;
      }
    });
    const actions = page.getByTestId("import-review-actions");
    await expect(actions).toBeVisible();
    const geometry = await actions.evaluate(element => {
      const bounds = element.getBoundingClientRect();
      return {
        top: bounds.top, bottom: bounds.bottom, height: bounds.height,
        viewport: innerHeight,
        buttons: Array.from(element.querySelectorAll("button")).map(button => {
          const rect = button.getBoundingClientRect();
          const x = rect.left + rect.width / 2, y = rect.top + rect.height / 2;
          const hit = document.elementFromPoint(x, y);
          return { text: button.textContent, top: rect.top, bottom: rect.bottom,
            inViewport: rect.top >= 0 && rect.bottom <= innerHeight && rect.left >= 0 && rect.right <= innerWidth,
            unobscured: hit === button || button.contains(hit) };
        }),
      };
    });
    const table = await page.getByTestId("planning-draft-flow").locator("table").first().evaluate(element => {
      const container = element.parentElement!;
      const bounds = container.getBoundingClientRect();
      return { height: bounds.height, scrollHeight: container.scrollHeight, clientHeight: container.clientHeight,
        overflowY: getComputedStyle(container).overflowY, maxHeight: getComputedStyle(container).maxHeight,
        headerPosition: getComputedStyle(element.querySelector("thead")!).position,
        rows: element.querySelectorAll("tbody tr").length };
    });
    measurements.push({ label, width, height, actions: geometry, table });
    await page.screenshot({ path: info.outputPath(`${label}.png`) });
    expect.soft(geometry.buttons.every(button => button.inViewport && button.unobscured),
      `${label}: both review actions visible and hit-testable without page scrolling; ${JSON.stringify(geometry)}`).toBe(true);
    if (width >= 768) {
      expect.soft(table.height).toBeLessThanOrEqual(height * .6 + 1);
      expect.soft(table.scrollHeight).toBeGreaterThan(table.clientHeight);
      expect.soft(table.headerPosition).toBe("sticky");
    }
  }
  await capture("compact-review-1024", 1024, 768);
  await capture("compact-review-390", 390, 844);
  await expect.poll(() => draft.state.step).toBe(3);
  await page.goto(`/dispatch?workflow=import&draftId=${draft.id}`);
  await expect(page.getByRole("dialog").getByTestId("import-review-filters")).toBeVisible();
  await page.getByTestId("import-review-filter-all").click();
  await capture("embedded-review-1024", 1024, 768);
  await capture("embedded-review-390", 390, 844);
  await info.attach("review-layout-measurements", { body: JSON.stringify(measurements, null, 2), contentType: "application/json" });
  console.log("Review layout measurements:", JSON.stringify(measurements));
  expect(blockedWrites).toEqual([]);
});

test("district is denied by default, tenant admin cannot grant, fixture platform policy enables UI", async ({ page }, info) => {
  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);
  await policy(organizationId, false);
  await page.goto("/districts");
  await expect(page.getByText("Distriktsmodulen är inte tillgänglig för organisationen.", { exact: false })).toBeVisible();
  expect((await page.request.get("/api/district-plans")).status()).toBe(403);
  const denied = await page.request.put(`/api/platform/organizations/${organizationId}/services`, { data: { revision: 1, policy: { districtEnabled: true } } });
  expect(denied.status()).toBe(403);
  await page.screenshot({ path: info.outputPath("district-denied-desktop.png") });
  await policy(organizationId, true);
  await page.reload();
  await expect(page.getByTestId("page-districts")).toBeVisible();
  expect((await page.request.get("/api/district-plans")).status()).toBe(200);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.getByTestId("button-create-plan")).toBeVisible();
  await page.screenshot({ path: info.outputPath("district-enabled-mobile.png") });
  await policy(organizationId, false);
});
