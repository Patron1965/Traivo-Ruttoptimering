import { expect, test, type Page, type BrowserContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  cleanupDisposableAuthFixture,
  provisionDisposableAuthFixture,
  type DisposableAuthFixture,
} from "./planning-draft-fixture";

test.setTimeout(240_000);

const DEPOT = { latitude: 59.3293, longitude: 18.0686 };
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADUlEQVQImWNgYGD4DwABBAEAHnOcQAAAAABJRU5ErkJggg==",
  "base64",
);

type Result = { status: number; body: any };
type RouteFixture = {
  organizationId: string;
  driverId: string;
  driverEmail: string;
  routeId: string;
  planId: string;
  stopIds: string[];
};

async function api(page: Page, path: string, method = "GET", body?: unknown): Promise<Result> {
  const response = await page.request.fetch(path, {
    method,
    ...(body === undefined ? {} : { data: body }),
  });
  return { status: response.status(), body: await response.json().catch(() => null) };
}

async function hardDisableNotifications(organizationId: string) {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(
    "pnpm",
    ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
      import { pool } from "@workspace/db";
      (async () => { try {
        const org = await pool.query(
          "UPDATE organizations SET sms_enabled=false, notify_sms_approaching=false, notify_sms_delivered=false, notify_sms_failed=false WHERE id=$1 RETURNING sms_enabled,notify_sms_approaching,notify_sms_delivered,notify_sms_failed",
          [process.env.T_ORG]);
        if (org.rowCount !== 1 || Object.values(org.rows[0]).some(Boolean)) {
          throw new Error("External notification flags were not disabled");
        }
        const integrations = await pool.query(
          "SELECT (SELECT count(*) FROM webhooks WHERE organization_id=$1) + (SELECT count(*) FROM shopify_integrations WHERE organization_id=$1) AS total",
          [process.env.T_ORG]);
        if (Number(integrations.rows[0].total) !== 0) throw new Error("Disposable tenant has external integrations");
      } finally { await pool.end(); } })();
    `],
    { env: { ...process.env, T_ORG: organizationId } },
  );
}

async function loginPlanner(page: Page, fixture: DisposableAuthFixture) {
  await page.goto("/routes/create");
  await expect(page.locator("#email")).toBeVisible();
  await page.locator("#email").fill(fixture.email);
  await page.locator("#password").fill(fixture.password);
  await page.locator("#password").press("Enter");
  await expect(page.getByTestId("input-draft-name")).toBeVisible();
}

async function provisionDispatchedRoute(
  page: Page,
  fixture: DisposableAuthFixture,
  count: number,
): Promise<RouteFixture> {
  const suffix = randomUUID().slice(0, 8);
  const organizationId = fixture.organizationId;
  const hooks = await api(page, `/api/webhooks?organizationId=${organizationId}`);
  expect(hooks.status).toBe(200);
  expect(hooks.body).toEqual([]);
  const vehicle = await api(page, "/api/vehicles", "POST", {
    organizationId, name: `E2E isolated vehicle ${suffix}`, licensePlate: `ISO-${suffix}`,
    vehicleType: "fossil", capacityKg: 1000, capacityVolume: 30, isActive: true,
  });
  expect(vehicle.status, JSON.stringify(vehicle.body)).toBe(201);
  const driver = await api(page, "/api/drivers", "POST", {
    organizationId, name: `E2E phone-free driver ${suffix}`, vehicleId: vehicle.body.id,
    isActive: true, capacityKg: 1000, capacityVolume: 30,
  });
  expect(driver.status, JSON.stringify(driver.body)).toBe(201);
  expect(driver.body.phone ?? null).toBeNull();
  const stopIds: string[] = [];
  for (let index = 0; index < count; index++) {
    const stop = await api(page, "/api/stops", "POST", {
      organizationId, address: `E2E isolated ${suffix} stop ${index + 1}`,
      latitude: DEPOT.latitude + index * 0.0002,
      longitude: DEPOT.longitude + index * 0.0002,
      jobType: "delivery", serviceDurationMin: 5,
    });
    expect(stop.status, JSON.stringify(stop.body)).toBe(201);
    stopIds.push(stop.body.id);
  }
  const driverEmail = `driver-${fixture.email}`;
  const driverUserId = randomUUID();
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  await promisify(execFile)(
    "pnpm",
    ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
      import { pool } from "@workspace/db";
      (async () => { try {
        const r = await pool.query(
          "INSERT INTO users (id,organization_id,name,email,role,password_hash,driver_profile_id) SELECT $1,organization_id,'Synthetic phone-free driver',$2,'driver',password_hash,$3 FROM users WHERE id=$4 AND organization_id=$5 RETURNING id",
          [process.env.T_USER,process.env.T_EMAIL,process.env.T_DRIVER,process.env.T_OWNER,process.env.T_ORG]);
        if (r.rowCount !== 1) throw new Error("Disposable planner user missing");
      } finally { await pool.end(); } })();
    `],
    { env: { ...process.env, T_USER: driverUserId, T_EMAIL: driverEmail,
      T_DRIVER: driver.body.id, T_OWNER: fixture.userId, T_ORG: organizationId } },
  );
  const draft = await api(page, "/api/planning-drafts", "POST", {
    name: `E2E isolated dispatch ${suffix}`, startAt: "2099-06-17T00:00:00.000Z", state: { step: 6 },
  });
  expect(draft.status, JSON.stringify(draft.body)).toBe(201);
  const plan = await api(page, "/api/import/route-plans", "POST", {
    draftId: draft.body.id, stopIds, pairs: [{ vehicleId: vehicle.body.id, driverId: driver.body.id }],
    date: "2099-06-17T00:00:00.000Z", depotLatitude: DEPOT.latitude, depotLongitude: DEPOT.longitude,
  });
  expect(plan.status, JSON.stringify(plan.body)).toBe(200);
  expect(plan.body.routes).toHaveLength(1);
  const { routeId, planId } = plan.body.routes[0];
  const approval = await api(page, `/api/import/route-plans/${planId}/approve`, "POST", {
    routes: [{ routeId, planRevision: plan.body.routes[0].planRevision, driverId: driver.body.id }],
  });
  expect(approval.status, JSON.stringify(approval.body)).toBe(200);
  const dispatch = await api(page, `/api/routes/${routeId}/dispatch`, "POST", {
    driverId: driver.body.id, planRevision: plan.body.routes[0].planRevision,
  });
  expect(dispatch.status, JSON.stringify(dispatch.body)).toBe(200);
  const snapshot = await api(page, `/api/routes/${routeId}/dispatch-snapshot`);
  expect(snapshot.status, JSON.stringify(snapshot.body)).toBe(200);
  expect(snapshot.body.stops).toHaveLength(count);
  const assignedStops = await api(page, `/api/routes/${routeId}/stops`);
  expect(assignedStops.status).toBe(200);
  const orderedStopIds = assignedStops.body
    .sort((a: any, b: any) => a.sequenceOrder - b.sequenceOrder)
    .map((stop: any) => stop.id);
  return { organizationId, driverId: driver.body.id, driverEmail, routeId, planId, stopIds: orderedStopIds };
}

async function driverContext(page: Page, url?: string): Promise<{ context: BrowserContext; mobile: Page }> {
  const context = await page.context().browser()!.newContext({
    viewport: { width: 402, height: 874 },
    permissions: ["geolocation"],
    geolocation: { latitude: DEPOT.latitude, longitude: DEPOT.longitude, accuracy: 5 },
    ignoreHTTPSErrors: true,
  });
  const mobile = await context.newPage();
  mobile.setDefaultTimeout(20_000);
  await mobile.goto(url ?? process.env.E2E_DRIVER_URL ?? "http://127.0.0.1:18809/", { waitUntil: "domcontentloaded" });
  return { context, mobile };
}

async function loginAndAcceptDriver(mobile: Page, planner: Page, auth: DisposableAuthFixture, f: RouteFixture) {
  await expect(mobile.getByPlaceholder("namn@foretag.se")).toBeVisible();
  await mobile.getByPlaceholder("namn@foretag.se").fill(f.driverEmail);
  await mobile.getByPlaceholder("Ditt lösenord").fill(auth.password);
  await mobile.getByText("Logga in", { exact: true }).click();
  await mobile.getByText("Godkänn rutt", { exact: true }).click();
  await mobile.getByText("Bekräfta", { exact: true }).click();
  await expect.poll(async () => (await api(planner, `/api/routes/${f.routeId}`)).body.handoffStatus).toBe("accepted");
}

async function uploadPhoto(mobile: Page, buttonName: string) {
  const chooserPromise = mobile.waitForEvent("filechooser");
  await mobile.getByText(buttonName, { exact: true }).click();
  const chooser = await chooserPromise;
  await chooser.setFiles({ name: "synthetic-evidence.png", mimeType: "image/png", buffer: PNG });
}

test("phone-free synthetic driver reports failed and skipped outcomes with required evidence and sync confirmation", async ({ page }, testInfo) => {
  const auth = await provisionDisposableAuthFixture(randomUUID());
  let context: BrowserContext | undefined;
  try {
    await hardDisableNotifications(auth.organizationId);
    await loginPlanner(page, auth);
    const f = await provisionDispatchedRoute(page, auth, 2);
    ({ context } = await driverContext(page));
    const mobile = context.pages()[0];
    await loginAndAcceptDriver(mobile, page, auth, f);
    const failedOutcomeRequests: Array<{ body: any; status?: number; responseBody?: any }> = [];
    mobile.on("request", (request) => {
      if (request.method() === "POST" && request.url().includes(`/api/stops/${f.stopIds[0]}/execution-events`)) {
        failedOutcomeRequests.push({ body: request.postDataJSON() });
      }
    });
    mobile.on("response", async (response) => {
      if (response.request().method() === "POST" && response.url().includes(`/api/stops/${f.stopIds[0]}/execution-events`)) {
        const event = failedOutcomeRequests.find((entry) => entry.status === undefined &&
          entry.body?.clientEventId === response.request().postDataJSON()?.clientEventId);
        if (event) {
          event.status = response.status();
          event.responseBody = await response.json().catch(() => null);
        }
      }
    });
    await mobile.getByTestId(`report-stop-${f.stopIds[0]}`).click();
    await mobile.getByTestId(`report-failed-${f.stopIds[0]}`).click();
    await expect(mobile.getByTestId("save-stop-report")).toHaveAttribute("aria-disabled", "true");
    await expect(mobile.getByTestId("report-failure-reason-customer_unavailable")).toHaveAttribute("aria-checked", "false");
    expect(failedOutcomeRequests).toHaveLength(0);
    await mobile.screenshot({ path: testInfo.outputPath("failed-reason-required-mobile.png"), fullPage: true });
    await mobile.getByTestId("report-failure-reason-access_problem").click();
    await expect(mobile.getByTestId("report-failure-reason-access_problem")).toHaveAttribute("aria-checked", "true");
    await expect.poll(() => mobile.evaluate(() => new Promise<boolean>((resolve, reject) => {
      const opening = indexedDB.open("traivo-driver-private", 1);
      opening.onerror = () => reject(opening.error);
      opening.onsuccess = () => {
        const database = opening.result;
        const transaction = database.transaction("kv", "readonly");
        const cursor = transaction.objectStore("kv").openCursor();
        let found = false;
        cursor.onsuccess = () => {
          const item = cursor.result;
          if (!item) return;
          if (String(item.key).includes("routeai_report_draft_") &&
              String(item.value).includes('"reportFailureReason":"access_problem"')) found = true;
          item.continue();
        };
        transaction.oncomplete = () => { database.close(); resolve(found); };
        transaction.onerror = () => { database.close(); reject(transaction.error); };
      };
    }))).toBe(true);
    await mobile.goBack();
    await mobile.getByTestId(`report-stop-${f.stopIds[0]}`).click();
    await mobile.getByTestId(`report-failed-${f.stopIds[0]}`).click();
    await expect(mobile.getByTestId("report-failure-reason-access_problem")).toHaveAttribute("aria-checked", "true");
    expect(failedOutcomeRequests).toHaveLength(0);
    await mobile.getByText("Rapportera avvikelse", { exact: true }).click();
    const exceptionSave = mobile.getByText("Spara rapport", { exact: true }).last();
    await expect(exceptionSave.locator("..")).toHaveAttribute("aria-disabled", "true");
    await mobile.getByPlaceholder("Beskriv vad som hänt...").fill("Synthetic failure reason: customer unavailable.");
    await expect(exceptionSave.locator("..")).toHaveAttribute("aria-disabled", "true");
    await uploadPhoto(mobile, "Bifoga foto");
    await expect(mobile.getByText("Foto bifogat", { exact: true })).toBeVisible();
    await expect(exceptionSave.locator("..")).not.toHaveAttribute("aria-disabled", "true");
    await exceptionSave.click();

    await mobile.locator("textarea").last().fill("Synthetic failed outcome reason; photo attached.");
    await uploadPhoto(mobile, "Foto");
    let releaseFailedSync: (() => void) | undefined;
    const failedStopRefreshStatuses: number[] = [];
    await context.route(`**/api/routes/${f.routeId}/stops`, async (route) => {
      if (route.request().method() !== "GET") {
        await route.continue();
        return;
      }
      failedStopRefreshStatuses.push(503);
      await route.fulfill({
        status: 503,
        contentType: "application/json",
        body: JSON.stringify({ error: "Synthetic stop-list refresh failure" }),
      });
    });
    await context.route(`**/api/stops/${f.stopIds[0]}/execution-events`, async (route) => {
      await new Promise<void>((resolve) => {
        releaseFailedSync = resolve;
      });
      await route.continue();
    });
    // Keep the failed outcome queued until its local confirmation is visible.
    const saveReport = mobile.getByTestId("save-stop-report");
    await context.setOffline(true);
    await saveReport.click();
    await expect(mobile.getByText("Sparat på enheten", { exact: true })).toBeVisible();
    await context.setOffline(false);
    await expect.poll(() => Boolean(releaseFailedSync)).toBe(true);
    await expect(mobile.getByText("Sparat på enheten", { exact: true })).toBeVisible();
    releaseFailedSync!();
    await expect(mobile.getByText("Synkat med trafikledningen", { exact: true }).last()).toBeVisible({ timeout: 30_000 });
    await expect.poll(() => failedOutcomeRequests.some((event) => event.status === 201)).toBe(true);
    const failedEvent = failedOutcomeRequests.find((event) => event.status === 201)!;
    expect(new Set(failedOutcomeRequests.map((event) => event.body.clientEventId)).size).toBe(1);
    expect(failedEvent.body.type).toBe("failed");
    expect(failedEvent.body.comment).toContain("access_problem");
    expect(failedEvent.body.comment).not.toContain("customer_unavailable");
    expect(failedEvent.responseBody.event.eventType).toBe("failed");
    expect(failedEvent.responseBody.event.clientEventId).toBe(failedEvent.body.clientEventId);
    expect((await api(page, `/api/stops/${f.stopIds[0]}`)).body.status).toBe("failed");
    const failedProofs = await api(page, `/api/stops/${f.stopIds[0]}/proofs`);
    expect(failedProofs.status).toBe(200);
    expect(failedProofs.body.length).toBeGreaterThan(0);
    await mobile.getByRole("button", { name: "Till ruttöversikten", exact: true }).click();
    // The stop query is inactive on the proof screen. Returning to the route
    // triggers its stale refresh; failure must not undo the committed report.
    await expect.poll(() => failedStopRefreshStatuses.length).toBeGreaterThan(0);
    expect((await api(page, `/api/stops/${f.stopIds[0]}`)).body.status).toBe("failed");
    await context.unroute(`**/api/routes/${f.routeId}/stops`);
    await mobile.reload();

    await mobile.getByTestId(`report-stop-${f.stopIds[1]}`).click();
    await mobile.getByTestId(`skip-stop-${f.stopIds[1]}`).click();
    await expect(mobile.getByTestId("confirm-skip")).toHaveAttribute("aria-disabled", "true");
    await mobile.getByTestId("skip-reason-CUSTOMER_UNAVAILABLE").click();
    await mobile.getByTestId("skip-comment").fill("Synthetic skip reason.");
    await mobile.getByTestId("confirm-skip").click();
    await expect.poll(async () => (await api(page, `/api/stops/${f.stopIds[1]}`)).body.status).toBe("skipped");
    const skipped = (await api(page, `/api/stops/${f.stopIds[1]}`)).body;
    expect(skipped.skipReason).toBe("CUSTOMER_UNAVAILABLE");
    expect(skipped.skipComment).toContain("Synthetic skip reason.");
    await expect(mobile.getByTestId("confirm-skip")).toHaveCount(0);
    await expect(mobile.getByText("Hoppades över", { exact: true })).toBeVisible();
    await mobile.screenshot({ path: testInfo.outputPath("driver-failed-and-skipped.png"), fullPage: true });
  } finally {
    await context?.close();
    await cleanupDisposableAuthFixture(auth);
  }
});

test("planner polls a held stale 2/3 response to authoritative 3/3 without WebSocket and after reload", async ({ page }, testInfo) => {
  const auth = await provisionDisposableAuthFixture(randomUUID());
  let context: BrowserContext | undefined;
  try {
    await hardDisableNotifications(auth.organizationId);
    await loginPlanner(page, auth);
    const f = await provisionDispatchedRoute(page, auth, 3);
    ({ context } = await driverContext(page));
    const mobile = context.pages()[0];
    await loginAndAcceptDriver(mobile, page, auth, f);
    for (const stopId of f.stopIds) {
      const stop = (await api(page, `/api/stops/${stopId}`)).body;
      await context.setGeolocation({ latitude: stop.latitude, longitude: stop.longitude, accuracy: 5 });
      await mobile.getByTestId(`report-stop-${stopId}`).click();
      await mobile.getByTestId(`report-completed-${stopId}`).click();
      await mobile.getByTestId("save-stop-report").click();
      await expect(mobile.getByText("Synkat med trafikledningen", { exact: true }).last()).toBeVisible({ timeout: 30_000 });
      await expect.poll(async () => (await api(page, `/api/stops/${stopId}`)).body.status).toBe("completed");
      await mobile.getByRole("button", { name: "Till ruttöversikten", exact: true }).click();
    }
    await expect.poll(async () => {
      const stops = (await api(page, `/api/routes/${f.routeId}/stops`)).body;
      return stops.filter((s: any) => s.status === "completed").length;
    }).toBe(3);

    let outgoingCalls = 0;
    let releaseCompleted!: () => void;
    let completedResponseReady!: () => void;
    const release = new Promise<void>((resolve) => { releaseCompleted = resolve; });
    const responseReady = new Promise<void>((resolve) => { completedResponseReady = resolve; });
    let blockedWebSocketAttempts = 0;
    await page.routeWebSocket("**/*", (socket) => { blockedWebSocketAttempts += 1; socket.close(); });
    await page.route("**/api/routes/outgoing-view?*", async (route) => {
      outgoingCalls += 1;
      const response = await route.fetch();
      const body = await response.json();
      if (outgoingCalls === 1) {
        body.stops[0].status = "pending";
        await route.fulfill({ response, json: body });
        return;
      }
      completedResponseReady();
      await release;
      await route.fulfill({ response, json: body });
    });
    await page.goto(`/dispatch?view=live&planId=${f.planId}`);
    await expect(page.getByTestId("dispatch-split")).toBeVisible();
    const overview = page.getByTestId("dispatch-plan-overview");
    await overview.locator("summary").first().click();
    await expect(page.getByTestId("live-delivery-progress")).toBeVisible();
    await expect(page.getByTestId("live-delivery-progress")).toContainText("Utförda stopp: 2/3", { timeout: 30_000 });
    await responseReady;
    expect(outgoingCalls).toBeGreaterThanOrEqual(2);
    expect(blockedWebSocketAttempts).toBeGreaterThan(0);
    releaseCompleted();
    await expect(page.getByTestId("live-delivery-progress")).toBeVisible();
    await expect(page.getByTestId("live-delivery-progress")).toContainText("Utförda stopp: 3/3", { timeout: 15_000 });
    const authoritative = (await api(page, `/api/routes/${f.routeId}/stops`)).body;
    expect(authoritative).toHaveLength(3);
    expect(authoritative.every((stop: any) => stop.status === "completed")).toBe(true);
    await page.reload();
    await expect(page.getByTestId("dispatch-plan-overview").locator("summary").first()).toBeVisible();
    await page.getByTestId("dispatch-plan-overview").locator("summary").first().click();
    await expect(page.getByTestId("live-delivery-progress")).toBeVisible();
    await expect(page.getByTestId("live-delivery-progress")).toContainText("Utförda stopp: 3/3", { timeout: 30_000 });
    await page.screenshot({ path: testInfo.outputPath("planner-live-3-of-3-after-reload.png"), fullPage: true });
  } finally {
    await context?.close();
    await cleanupDisposableAuthFixture(auth);
  }
});

test("graduated driver map previews stops and keeps the accepted route selected without writes", async ({ page }, testInfo) => {
  const auth = await provisionDisposableAuthFixture(randomUUID());
  let context: BrowserContext | undefined;
  try {
    await hardDisableNotifications(auth.organizationId);
    await loginPlanner(page, auth);
    const f = await provisionDispatchedRoute(page, auth, 2);
    ({ context } = await driverContext(page, `https://${process.env.REPLIT_EXPO_DEV_DOMAIN}/`));
    const mobile = context.pages()[0];
    await loginAndAcceptDriver(mobile, page, auth, f);
    const operationalWrites: string[] = [];
    mobile.on("request", request => {
      if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method()) &&
          new URL(request.url()).pathname.startsWith("/api/")) {
        operationalWrites.push(`${request.method()} ${new URL(request.url()).pathname}`);
      }
    });

    await mobile.getByText("Karta", { exact: true }).click();
    await expect(mobile.getByTestId("driver-map-screen")).toBeVisible();
    await expect(mobile.getByTestId("driver-geographic-map")).toBeVisible();
    await expect(mobile.getByTestId("map-progress")).toContainText("0 / 2");
    const stops = (await api(page, `/api/routes/${f.routeId}/stops`)).body
      .sort((a: any, b: any) => a.sequenceOrder - b.sequenceOrder);
    const firstAddress = stops[0].address as string;
    const laterAddress = stops[1].address as string;
    await expect(mobile.getByTestId("map-next-stop")).toContainText(firstAddress);

    const mapBox = await mobile.getByTestId("driver-geographic-map").boundingBox();
    const nextBox = await mobile.getByTestId("map-next-stop").boundingBox();
    expect(mapBox).not.toBeNull();
    expect(nextBox).not.toBeNull();
    expect(mapBox!.y + mapBox!.height).toBeLessThanOrEqual(nextBox!.y);
    for (const control of ["in", "out", "fit"]) {
      await expect(mobile.getByTestId(`map-control-${control}`)).toBeVisible();
    }
    await expect(mobile.getByRole("button", { name: "Zooma in", exact: true })).toBeVisible();
    await expect(mobile.getByRole("button", { name: "Zooma ut", exact: true })).toBeVisible();
    await expect(mobile.getByRole("button", { name: "Visa hela rutten", exact: true })).toBeVisible();
    const addressFontSize = await mobile.getByTestId("map-next-stop").getByText(firstAddress, { exact: true }).evaluate(element =>
      Number.parseFloat(getComputedStyle(element).fontSize));
    expect(addressFontSize).toBeGreaterThanOrEqual(16);
    const readTileZooms = () => mobile.locator(".leaflet-tile-container img.leaflet-tile").evaluateAll(images =>
      [...new Set(images.map(image => (image.getAttribute("src") ?? "").match(/\/(\d+)\/\d+\/\d+\.(?:png|jpg|webp)/)?.[1])
        .filter(Boolean))].sort().join(","));
    await expect.poll(readTileZooms).not.toBe("");
    const initialZooms = await readTileZooms();
    await mobile.getByTestId("map-control-in").click();
    await expect.poll(readTileZooms).not.toBe(initialZooms);
    const zoomedInLevels = await readTileZooms();
    await mobile.getByTestId("map-control-out").click();
    await expect.poll(readTileZooms).not.toBe(zoomedInLevels);
    await mobile.getByTestId("map-control-fit").click();

    await mobile.getByTestId(`map-preview-${f.stopIds[1]}`).click();
    await expect(mobile.getByTestId("map-stop-preview")).toContainText(laterAddress);
    await expect(mobile.getByTestId("map-next-stop")).toContainText(firstAddress);
    await expect(mobile.getByTestId("map-stop-preview")).toContainText("ändrar inte nästa stopp");
    await expect(mobile.getByText("Stäng förhandsvisning", { exact: true })).toBeVisible();
    await mobile.getByText("Stäng förhandsvisning", { exact: true }).click();
    await expect(mobile.getByTestId("map-stop-preview")).toHaveCount(0);
    expect(operationalWrites).toEqual([]);
    await mobile.screenshot({ path: testInfo.outputPath("graduated-driver-map-mobile.png"), fullPage: true });

    await mobile.reload();
    await expect(mobile.getByTestId("driver-map-screen")).toBeVisible();
    await expect(mobile.getByTestId("map-next-stop")).toContainText(firstAddress);
    await expect(mobile.getByTestId("map-stop-preview")).toHaveCount(0);
    await expect(mobile.getByTestId("map-progress")).toContainText("0 / 2");
    await mobile.setViewportSize({ width: 1100, height: 850 });
    await expect(mobile.getByTestId("driver-geographic-map")).toBeVisible();
    await mobile.screenshot({ path: testInfo.outputPath("graduated-driver-map-desktop.png"), fullPage: true });
    expect(operationalWrites).toEqual([]);
  } finally {
    await context?.close();
    await cleanupDisposableAuthFixture(auth);
  }
});
