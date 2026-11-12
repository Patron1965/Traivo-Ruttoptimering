import { expect, test, type Page, type Request } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

/**
 * This spec intentionally uses the named-draft wizard rather than creating a
 * route directly. The wizard owns the state transitions; the API assertions
 * below make sure those transitions are persisted and tenant-scoped. Each run
 * provisions a disposable organization with its own verified depot, so no
 * shared customer settings or integrations are touched.
 *
 * Stable UI contract used by this regression:
 * - input-draft-name, input-draft-date,
 *   button-draft-start-import, import-file-input
 * - planning-draft-save-stops, planning-draft-vehicle-pair-<vehicle>-<driver>,
 *   planning-draft-optimize, planning-draft-save-review
 * - The dispatch planner exposes planning-draft-approve and
 *   planning-draft-dispatch-<route> after validation.  Approval remains a
 *   separate action from validation and dispatch.
 * - planning-draft-flow, planning-draft-route,
 *   planning-draft-geocode-candidate-<candidate>
 *
 * The first group already exists on the draft entry page.  The remaining
 * identifiers are deliberately explicit so a selector change cannot turn
 * this persistence regression into a false positive.
 */

test.setTimeout(240_000);

type ApiResult = {
  status: number;
  body: any;
};

const IMPORT_DEFAULT_DEPOT = {
  latitude: 59.3293,
  longitude: 18.0686,
};

const DEPOT_SNAPSHOT = {
  start: {
    address: "E2E planning verified depot start, Stockholm",
    latitude: IMPORT_DEFAULT_DEPOT.latitude,
    longitude: IMPORT_DEFAULT_DEPOT.longitude,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: {
      provider: "nominatim",
      source: "nominatim",
      displayName: "E2E planning verified depot start, Stockholm",
      query: "E2E planning verified depot start, Stockholm",
    },
  },
  end: {
    address: "E2E planning verified depot end, Stockholm",
    latitude: IMPORT_DEFAULT_DEPOT.latitude,
    longitude: IMPORT_DEFAULT_DEPOT.longitude,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: {
      provider: "nominatim",
      source: "nominatim",
      displayName: "E2E planning verified depot end, Stockholm",
      query: "E2E planning verified depot end, Stockholm",
    },
  },
} as const;

type DisposableAuthFixture = {
  organizationId: string;
  userId: string;
  email: string;
  password: string;
};

const execFileAsync = promisify(execFile);

async function provisionDisposableAuthFixture(
  suffix: string,
): Promise<DisposableAuthFixture> {
  const fixture: DisposableAuthFixture = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    email: `e2e-planning-draft-${suffix}@example.test`,
    password: `Planning-${randomUUID()}-Aa1!`,
  };

  const script = `
    import { randomBytes, scrypt } from "node:crypto";
    import { promisify } from "node:util";
    import { db, organizationsTable, pool, usersTable } from "@workspace/db";

    const scryptAsync = promisify(scrypt);
    const organizationId = process.env.E2E_PLANNING_DRAFT_ORGANIZATION_ID;
    const userId = process.env.E2E_PLANNING_DRAFT_USER_ID;
    const email = process.env.E2E_PLANNING_DRAFT_EMAIL;
    const password = process.env.E2E_PLANNING_DRAFT_PASSWORD;
    if (!organizationId || !userId || !email || !password) {
      throw new Error("Planning draft fixture arguments are missing");
    }

    void (async () => {
      const salt = randomBytes(16).toString("hex");
      const derived = (await scryptAsync(password, salt, 64)) as Buffer;
      await db.insert(organizationsTable).values({
        id: organizationId,
        name: "E2E planning draft disposable organization",
        email,
        depotStartAddress: ${JSON.stringify(DEPOT_SNAPSHOT.start.address)},
        depotStartLatitude: ${DEPOT_SNAPSHOT.start.latitude},
        depotStartLongitude: ${DEPOT_SNAPSHOT.start.longitude},
        depotStartVerifiedAt: new Date(${JSON.stringify(DEPOT_SNAPSHOT.start.verifiedAt)}),
        depotStartVerification: ${JSON.stringify(DEPOT_SNAPSHOT.start.verification)},
        depotEndAddress: ${JSON.stringify(DEPOT_SNAPSHOT.end.address)},
        depotEndLatitude: ${DEPOT_SNAPSHOT.end.latitude},
        depotEndLongitude: ${DEPOT_SNAPSHOT.end.longitude},
        depotEndVerifiedAt: new Date(${JSON.stringify(DEPOT_SNAPSHOT.end.verifiedAt)}),
        depotEndVerification: ${JSON.stringify(DEPOT_SNAPSHOT.end.verification)},
      });
      await db.insert(usersTable).values({
        id: userId,
        organizationId,
        name: "E2E planning draft disposable admin",
        email,
        role: "admin",
        passwordHash: \`scrypt:\${salt}:\${Buffer.from(derived).toString("hex")}\`,
      });
      await pool.end();
    })().catch(async (error) => {
      console.error(error);
      await pool.end();
      process.exitCode = 1;
    });
  `;

  await execFileAsync(
    "pnpm",
    ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", script],
    {
      env: {
        ...process.env,
        E2E_PLANNING_DRAFT_ORGANIZATION_ID: fixture.organizationId,
        E2E_PLANNING_DRAFT_USER_ID: fixture.userId,
        E2E_PLANNING_DRAFT_EMAIL: fixture.email,
        E2E_PLANNING_DRAFT_PASSWORD: fixture.password,
      },
    },
  );
  return fixture;
}

async function cleanupDisposableAuthFixture(
  fixture: DisposableAuthFixture,
): Promise<void> {
  const script = `
    import { pool } from "@workspace/db";

    const organizationId = process.env.E2E_PLANNING_DRAFT_ORGANIZATION_ID;
    if (!organizationId) throw new Error("Planning draft organization id is missing");

    void (async () => {
      const statements = [
        "DELETE FROM password_reset_tokens WHERE user_id IN (SELECT id FROM users WHERE organization_id = $1)",
        "DELETE FROM stop_message_read_receipts WHERE organization_id = $1",
        "DELETE FROM stop_messages WHERE organization_id = $1",
        "DELETE FROM stop_message_threads WHERE organization_id = $1",
        "DELETE FROM route_message_read_receipts WHERE organization_id = $1",
        "DELETE FROM route_messages WHERE organization_id = $1",
        "DELETE FROM delivery_proofs WHERE stop_id IN (SELECT id FROM stops WHERE organization_id = $1)",
        "DELETE FROM delivery_notifications WHERE stop_id IN (SELECT id FROM stops WHERE organization_id = $1)",
        "DELETE FROM execution_events WHERE organization_id = $1",
        "DELETE FROM route_acknowledgements WHERE organization_id = $1",
        "DELETE FROM route_executions WHERE organization_id = $1",
        "DELETE FROM geofence_events WHERE organization_id = $1",
        "DELETE FROM vehicle_positions WHERE organization_id = $1",
        "DELETE FROM route_plan_approvals WHERE organization_id = $1",
        "DELETE FROM route_incidents WHERE organization_id = $1",
        "DELETE FROM route_history WHERE organization_id = $1",
        "DELETE FROM driver_behavior_logs WHERE driver_id IN (SELECT id FROM drivers WHERE organization_id = $1)",
        "DELETE FROM driver_learned_profiles WHERE driver_id IN (SELECT id FROM drivers WHERE organization_id = $1)",
        "DELETE FROM driver_certifications WHERE organization_id = $1",
        "DELETE FROM driver_preferences WHERE driver_id IN (SELECT id FROM drivers WHERE organization_id = $1)",
        "DELETE FROM route_templates WHERE organization_id = $1",
        "DELETE FROM planning_drafts WHERE organization_id = $1",
        "DELETE FROM stops WHERE organization_id = $1",
        "DELETE FROM routes WHERE organization_id = $1",
        "DELETE FROM customers WHERE organization_id = $1",
        "DELETE FROM drivers WHERE organization_id = $1",
        "DELETE FROM vehicles WHERE organization_id = $1",
        "DELETE FROM webhooks WHERE organization_id = $1",
        "DELETE FROM shopify_integrations WHERE organization_id = $1",
        "DELETE FROM subscriptions WHERE organization_id = $1",
        "DELETE FROM notifications WHERE organization_id = $1",
        "DELETE FROM documents WHERE organization_id = $1",
        "DELETE FROM document_upload_intents WHERE organization_id = $1",
        "DELETE FROM service_report_materials WHERE organization_id = $1",
        "DELETE FROM service_reports WHERE organization_id = $1",
        "DELETE FROM audit_log WHERE organization_id = $1",
        "DELETE FROM sessions WHERE organization_id = $1",
        "DELETE FROM user_groups WHERE organization_id = $1",
        "DELETE FROM users WHERE organization_id = $1",
        "DELETE FROM organizations WHERE id = $1",
      ];
      try {
        for (const statement of statements) {
          await pool.query(statement, [organizationId]);
        }
      } finally {
        await pool.end();
      }
    })().catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
  `;

  await execFileAsync(
    "pnpm",
    ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", script],
    {
      env: {
        ...process.env,
        E2E_PLANNING_DRAFT_ORGANIZATION_ID: fixture.organizationId,
      },
    },
  );
}

async function loginAsDisposableUser(
  page: Page,
  fixture: DisposableAuthFixture,
): Promise<void> {
  await page.goto("/routes/create");
  const emailField = page.locator("#email");
  await expect(emailField).toBeVisible();
  await emailField.fill(fixture.email);
  await page.locator("#password").fill(fixture.password);
  await page.locator("#password").press("Enter");
  await expect(page.getByTestId("input-draft-name")).toBeVisible();
}

async function api(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<ApiResult> {
  const response = await page.request.fetch(path, {
    method,
    ...(body === undefined ? {} : { data: body }),
  });
  return {
    status: response.status(),
    body: await response.json().catch(() => null),
  };
}

function csvFixture(
  suffix: string,
  planningDate: string,
): {
  name: string;
  mimeType: string;
  buffer: Buffer;
} {
  // The first row is already geocoded.  The second deliberately has no
  // coordinates so the batch geocoder returns candidates for user correction.
  // Both points are close to the configured Stockholm depot and have generous
  // windows so the real optimizer can plan them without a provider stub.
  const headers = [
    "Ordernummer",
    "Namn",
    "Adress",
    "Latitud",
    "Longitud",
    "Datum",
    "Leverans från kl",
    "Leverans till kl",
    "Servicetid",
  ];
  const rows = [
    [
      `E2E-${suffix}-1`,
      `Planning draft known ${suffix}`,
      `E2E known address ${suffix}`,
      "59.3297",
      "18.0689",
      planningDate,
      "08:00",
      "11:00",
      "5",
    ],
    [
      `E2E-${suffix}-2`,
      `Planning draft uncertain ${suffix}`,
      `E2E uncertain address ${suffix}`,
      "",
      "",
      planningDate,
      "08:00",
      "11:00",
      "5",
    ],
  ];
  return {
    name: `planning-draft-${suffix}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      `\uFEFF${headers.join(";")}\r\n${rows.map((row) => row.join(";")).join("\r\n")}`,
      "utf8",
    ),
  };
}

function draftIdFromUrl(url: string): string {
  const match = url.match(/\/routes\/drafts\/([0-9a-f-]{36})(?:[/?#]|$)/i);
  if (!match) throw new Error(`Expected a planning draft URL, got ${url}`);
  return match[1];
}

async function planningDraft(page: Page, draftId: string): Promise<any> {
  const response = await api(page, `/api/planning-drafts/${draftId}`);
  expect(response.status).toBe(200);
  return response.body;
}

async function routeStops(page: Page, routeId: string): Promise<any[]> {
  const response = await api(page, `/api/routes/${routeId}/stops`);
  expect(response.status).toBe(200);
  expect(Array.isArray(response.body)).toBe(true);
  return response.body;
}

test("named planning draft persists import, validation, approval, and resume state", async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 1000 });

  const suffix = randomUUID().slice(0, 8);
  const planningDate = "2099-06-17";
  const startAt = `${planningDate}T00:00:00.000Z`;
  const draftName = `E2E planning draft ${suffix}`;
  const candidateId = `e2e-candidate-${suffix}`;
  const candidateLatitude = 59.3299;
  const candidateLongitude = 18.0691;

  const importedStopIds: string[] = [];
  const routeIds: string[] = [];
  let draftId: string | undefined;
  let organizationId: string | undefined;
  let authFixture: DisposableAuthFixture | undefined;

  const dispatchRequests: Request[] = [];
  const approvalRequests: Request[] = [];
  const geocodeRequests: unknown[] = [];

  // Only the external geocoder is stubbed.  Route-plan creation, adjustment,
  // and approval use the real API and database.  This spec deliberately never
  // invokes the handoff endpoint because it emits an external webhook.
  await page.route("**/api/geocode/batch", async (route) => {
    const body = route.request().postDataJSON() as {
      addresses?: Array<{ id?: string; address?: string }>;
    };
    const addresses = body.addresses ?? [];
    geocodeRequests.push(body);
    const results = addresses.map((address) => {
      if ((address.address ?? "").includes("uncertain")) {
        return {
          id: address.id,
          address: address.address,
          query: address.address,
          status: "candidates",
          result: null,
          candidates: [
            {
              id: candidateId,
              latitude: candidateLatitude,
              longitude: candidateLongitude,
              displayName: `E2E corrected address ${suffix}`,
              source: "nominatim",
              partial: false,
            },
          ],
        };
      }
      return {
        id: address.id,
        address: address.address,
        query: address.address,
        status: "matched",
        result: {
          latitude: 59.3297,
          longitude: 18.0689,
          displayName: address.address,
          source: "nominatim",
          provider: "nominatim",
        },
        candidates: [],
      };
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results,
        metrics: {
          requested: addresses.length,
          valid: addresses.length,
          unique: addresses.length,
          deduplicated: 0,
          durationMs: 0,
          cacheHits: 0,
          providerRequests: { google: 0, nominatim: 0 },
          statusCounts: {},
        },
      }),
    });
  });

  const recordTransitionRequest = (request: Request) => {
    if (request.method() !== "POST") return;
    if (
      request.url().includes("/api/routes/") &&
      request.url().endsWith("/dispatch")
    ) {
      dispatchRequests.push(request);
    }
    if (request.url().includes("/api/import/route-plans/") && request.url().endsWith("/approve")) {
      approvalRequests.push(request);
    }
  };
  page.on("request", recordTransitionRequest);

  try {
    // The entry card exposes its import/expand control before the draft fields
    // are available on the current CreateRoute surface.
    authFixture = await provisionDisposableAuthFixture(suffix);
    await loginAsDisposableUser(page, authFixture);
    organizationId = authFixture.organizationId;

    const vehicle = await api(page, "/api/vehicles", "POST", {
      organizationId,
      name: `E2E planning vehicle ${suffix}`,
      licensePlate: `PD-${suffix}`,
      vehicleType: "fossil",
      capacityKg: 1_000,
      capacityVolume: 50,
      isActive: true,
      driver: {
        name: `E2E planning driver ${suffix}`,
        capacityKg: 1_000,
        capacityVolume: 50,
      },
    });
    expect(vehicle.status).toBe(201);
    expect(vehicle.body.resourceProfile?.id).toBeTruthy();
    const driver = await api(page, `/api/drivers/${vehicle.body.resourceProfile.id}`);
    expect(driver.status).toBe(200);
    expect(driver.body.vehicleId).toBe(vehicle.body.id);
    await page.getByTestId("input-draft-name").fill(draftName);
    await page.getByTestId("input-draft-date").fill(planningDate);
    await expect(page.getByTestId("input-draft-time")).toHaveCount(0);
    await expect(page.getByTestId("input-draft-file")).toHaveCount(0);
    await page.getByTestId("button-draft-continue").click();
    await page.getByTestId("button-draft-start-import").click();

    await expect(page).toHaveURL(/\/routes\/drafts\/[0-9a-f-]{36}$/i);
    const currentDraftId = draftIdFromUrl(page.url());
    draftId = currentDraftId;
    const createdDraft = await planningDraft(page, currentDraftId);
    expect(createdDraft.name).toBe(draftName);
    expect(new Date(createdDraft.startAt).getTime()).toBe(
      new Date(startAt).getTime(),
    );

    // The real file input is intentionally hidden; the visible dropzone
    // delegates to it, while Playwright can attach the fixture directly.
    await expect(page.getByTestId("import-file-input")).toBeAttached();
    await page
      .getByTestId("import-file-input")
      .setInputFiles(csvFixture(suffix, planningDate));

    // The mapping is generated from the real CSV parser. Advancing through
    // the mapping, row-review, and address screens must not create stops
    // before the address candidate is corrected. These components expose
    // their Next buttons by the translated role.
    await page.getByRole("button", { name: /^(Nästa|Next)$/ }).click();
    await page.getByRole("button", { name: /^(Nästa|Next)$/ }).click();
    // Parsing already opened mapping: these two transitions reach addresses.
    await expect(
      page.getByTestId("planning-draft-geocode-candidate-" + candidateId),
    ).toBeVisible();
    expect(geocodeRequests.length).toBeGreaterThan(0);

    // Selecting the uncertain candidate supplies the corrected coordinates;
    // those coordinates are later checked again on the persisted stop.
    await page
      .getByTestId(`planning-draft-geocode-candidate-${candidateId}`)
      .click();
    await expect(page.getByTestId("planning-draft-save-stops")).toBeEnabled();

    const importResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/stops/import"),
    );
    await page.getByTestId("planning-draft-save-stops").click();
    const importResponse = await importResponsePromise;
    expect(importResponse.status()).toBe(201);
    const importBody = await importResponse.json();
    expect(importBody.savedRowCount).toBe(2);
    expect(importBody.stops).toHaveLength(2);
    importedStopIds.push(
      ...importBody.stops.map((stop: { id: string }) => stop.id),
    );

    const persistedStops = await api(
      page,
      `/api/stops?organizationId=${organizationId}`,
    );
    expect(persistedStops.status).toBe(200);
    const importedStopsById = new Map(
      persistedStops.body
        .filter((stop: { id: string }) => importedStopIds.includes(stop.id))
        .map((stop: any) => [stop.id, stop]),
    );
    expect(importedStopsById.size).toBe(2);
    expect(
      [...importedStopsById.values()].some(
        (stop: any) =>
          Math.abs(stop.latitude - candidateLatitude) < 0.000001 &&
          Math.abs(stop.longitude - candidateLongitude) < 0.000001,
      ),
    ).toBe(true);

    await expect(
      page.getByTestId(
        "planning-draft-vehicle-pair-" + vehicle.body.id + "-" + driver.body.id,
      ),
    ).toBeVisible();
    await page
      .getByTestId(
        `planning-draft-vehicle-pair-${vehicle.body.id}-${driver.body.id}`,
      )
      .click();

    const planRequests: Array<Record<string, unknown>> = [];
    const recordPlanRequest = (request: Request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/import/route-plans")
      ) {
        planRequests.push(request.postDataJSON() as Record<string, unknown>);
      }
    };
    page.on("request", recordPlanRequest);

    // Selecting a real pair is only local wizard state.  Optimization must be
    // an explicit action, never an effect of selecting the pair.
    await expect.poll(() => planRequests.length).toBe(0);
    const planResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/import/route-plans"),
    );
    await page.getByTestId("planning-draft-optimize").click();
    const planResponse = await planResponsePromise;
    page.off("request", recordPlanRequest);
    expect(planResponse.status()).toBe(200);
    const plan = await planResponse.json();
    expect(plan.planId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0].stopCount).toBe(2);
    expect(plan.unassignedStopIds).toEqual([]);
    expect(planRequests).toHaveLength(1);
    expect(planRequests[0].draftId).toBe(currentDraftId);
    expect(planRequests[0].stopIds).toEqual(
      expect.arrayContaining(importedStopIds),
    );
    expect(planRequests[0].pairs).toEqual([
      { vehicleId: vehicle.body.id, driverId: driver.body.id },
    ]);
    expect(new Date(String(planRequests[0].date)).getTime()).toBe(
      new Date(createdDraft.startAt).getTime(),
    );
    expect(planRequests[0].depotLatitude).toBe(IMPORT_DEFAULT_DEPOT.latitude);
    expect(planRequests[0].depotLongitude).toBe(IMPORT_DEFAULT_DEPOT.longitude);
    routeIds.push(
      ...plan.routes.map((route: { routeId: string }) => route.routeId),
    );

    const plannedRoute = await api(page, `/api/routes/${routeIds[0]}`);
    expect(plannedRoute.status).toBe(200);
    expect(plannedRoute.body.depotSnapshot).toMatchObject({
      start: {
        address: DEPOT_SNAPSHOT.start.address,
        latitude: DEPOT_SNAPSHOT.start.latitude,
        longitude: DEPOT_SNAPSHOT.start.longitude,
        verifiedAt: DEPOT_SNAPSHOT.start.verifiedAt,
        verification: DEPOT_SNAPSHOT.start.verification,
      },
      end: {
        address: DEPOT_SNAPSHOT.end.address,
        latitude: DEPOT_SNAPSHOT.end.latitude,
        longitude: DEPOT_SNAPSHOT.end.longitude,
        verifiedAt: DEPOT_SNAPSHOT.end.verifiedAt,
        verification: DEPOT_SNAPSHOT.end.verification,
      },
    });

    // A named plan is protected by the approval table, not just by the
    // legacy manual-review fields.  Dispatch must be rejected before approval.
    const approvalBefore = await api(
      page,
      `/api/import/route-plans/${plan.planId}/approval`,
    );
    expect(approvalBefore.status).toBe(200);
    expect(approvalBefore.body.protected).toBe(true);
    expect(approvalBefore.body.routes).toHaveLength(1);
    expect(approvalBefore.body).toMatchObject({
      planId: plan.planId,
      protected: true,
    });
    expect(approvalBefore.body.routes[0]).toMatchObject({
      routeId: routeIds[0],
      planId: plan.planId,
      draftId: currentDraftId,
      status: "optimized",
      vehicleId: vehicle.body.id,
      driverId: driver.body.id,
      approval: {
        approved: false,
        approvedAt: null,
        approvedByUserId: null,
      },
    });

    const dispatchBeforeApproval = await api(
      page,
      `/api/routes/${routeIds[0]}/dispatch`,
      "POST",
      { driverId: driver.body.id },
    );
    expect(dispatchBeforeApproval.status).toBe(409);
    expect(dispatchBeforeApproval.body?.error).toMatch(
      /approval|godkän|granskas/i,
    );

    // A stale route revision is a real backend validation failure.  Keep a
    // local reorder in the browser, advance the server revision behind the
    // browser, and prove that validation remains in Step 6 with the edit
    // intact instead of navigating to approval or dispatch.
    const routeBeforeConflict = await api(page, `/api/routes/${routeIds[0]}`);
    expect(routeBeforeConflict.status).toBe(200);
    const stopsBeforeConflict = await routeStops(page, routeIds[0]);
    const conflictStopIds = stopsBeforeConflict
      .sort((left, right) => left.sequenceOrder - right.sequenceOrder)
      .map((stop) => stop.id);
    const routeCard = page.getByTestId("planning-draft-route").first();
    const stopAddressOrder = () =>
      routeCard
        .locator("p")
        .filter({ hasText: new RegExp(`E2E .* address ${suffix}`) });
    const originalStopOrder = await stopAddressOrder().allTextContents();
    await page
      .getByRole("button", { name: /(?:Move|Flytta).*?(?:down|nedåt)/i })
      .first()
      .click();
    const editedStopOrder = await stopAddressOrder().allTextContents();
    expect(editedStopOrder).not.toEqual(originalStopOrder);

    const serverRevisionAdvance = await api(
      page,
      "/api/import/route-adjustments",
      "POST",
      {
        planId: plan.planId,
        routes: [{
          routeId: routeIds[0],
          driverId: driver.body.id,
          planRevision: routeBeforeConflict.body.planRevision,
          stopIds: conflictStopIds,
        }],
        depotLatitude: IMPORT_DEFAULT_DEPOT.latitude,
        depotLongitude: IMPORT_DEFAULT_DEPOT.longitude,
      },
    );
    expect(serverRevisionAdvance.status).toBe(200);

    const failedAdjustmentResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/import/route-adjustments/preview"),
    );
    await page.getByTestId("planning-draft-save-review").click();
    const failedAdjustmentResponse = await failedAdjustmentResponsePromise;
    expect(failedAdjustmentResponse.status()).toBe(409);
    await expect(page).toHaveURL(
      new RegExp(`/routes/drafts/${currentDraftId}$`),
    );
    const validationError = page.getByTestId("planning-validation-error");
    await expect(validationError).toHaveRole("alert");
    await expect(validationError).toContainText(
      /could not save|kunde inte spara|changed|ändrades|reload|ladda|krockar|uppdatera/i,
    );
    expect(await stopAddressOrder().allTextContents()).toEqual(editedStopOrder);
    expect(approvalRequests).toHaveLength(0);
    expect(dispatchRequests).toHaveLength(0);
    expect((await planningDraft(page, currentDraftId)).state.step).toBe(6);

    // Refresh only after asserting the failed local edit.  Hydration now
    // obtains the newer route revision, but the draft remains review step 6.
    await page.reload();
    await expect(page.getByTestId("planning-draft-save-review")).toBeVisible();
    const routeBeforeApproval = await api(page, `/api/routes/${routeIds[0]}`);
    expect(routeBeforeApproval.status).toBe(200);
    expect(routeBeforeApproval.body.status).toBe("optimized");

    // Reload discards the rejected local edit. Make a fresh edit so this
    // exercises preview/confirm rather than the clean-plan review shortcut.
    await page.getByRole("button", { name: /(?:Move|Flytta).*?(?:down|nedåt)/i }).first().click();
    const adjustmentPreviewPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/import/route-adjustments/preview"),
    );
    await page.getByTestId("planning-draft-save-review").click();
    const adjustmentPreview = await adjustmentPreviewPromise;
    expect(adjustmentPreview.status()).toBe(200);
    expect((await adjustmentPreview.json()).canApply).toBe(true);
    await expect(page.getByRole("region", { name: "Granska hela planändringen" })).toBeVisible();
    await page.getByLabel(/Jag har granskat hela förslaget/).check();
    const adjustmentResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/import/route-adjustments"),
    );
    await page.getByTestId("planning-draft-save-review").click();
    const adjustmentResponse = await adjustmentResponsePromise;
    expect(adjustmentResponse.status()).toBe(200);
    const savedRoute = await api(page, `/api/routes/${routeIds[0]}`);
    expect(savedRoute.status).toBe(200);
    expect(savedRoute.body.planRevision).toBe(
      routeBeforeApproval.body.planRevision + 1,
    );

    // Validation persists review step 6 and then takes the planner directly
    // to traffic for this exact plan.  It must not approve or dispatch.
    await expect.poll(() => {
      const current = new URL(page.url());
      return {
        pathname: current.pathname,
        view: current.searchParams.get("view"),
        planId: current.searchParams.get("planId"),
      };
    }).toEqual({
      pathname: "/dispatch",
      view: "traffic",
      planId: plan.planId,
    });
    await page.getByTestId("dispatch-plan-workflow-open").click();
    await expect(page.getByTestId("dispatch-plan-workflow-dialog")).toBeVisible();
    const validationSuccess = page
      .getByRole("alert")
      .filter({ hasText: /saved|validated|sparad|validerad/i })
      .first();
    await expect(validationSuccess).toBeVisible();
    await expect(
      page.getByTestId(`planning-draft-dispatch-${routeIds[0]}`),
    ).toHaveCount(0);
    await expect(page.getByTestId("planning-draft-approve")).toBeVisible();
    expect(approvalRequests).toHaveLength(0);
    expect(dispatchRequests).toHaveLength(0);

    const persistedDraftBeforeApproval = await planningDraft(page, currentDraftId);
    expect(persistedDraftBeforeApproval).toMatchObject({
      planId: plan.planId,
      state: { step: 6 },
    });

    // The unapproved persisted draft still hydrates as Step 6.  This explicit
    // check guards against a navigation marker being mistaken for approval.
    await page.goto(`/routes/drafts/${currentDraftId}`);
    await expect(page.getByTestId("planning-draft-save-review")).toBeVisible();
    await expect(
      page.getByTestId(`planning-draft-dispatch-${routeIds[0]}`),
    ).toHaveCount(0);
    await expect(page.getByTestId("planning-draft-approve")).toHaveCount(0);

    // Recovery regression: keep the read outage active until the user retries.
    // A one-shot 503 is consumed by automatic polling/transport retries and
    // cannot deterministically exercise the recovery controls. No
    // optimization, import, approval, or dispatch mutation is stubbed.
    let failApprovalRead = true;
    let failRouteRead = true;
    await page.route(
      `**/api/import/route-plans/${plan.planId}/approval`,
      async (route) => {
        if (failApprovalRead) {
          await route.fulfill({
            status: 503,
            contentType: "application/json",
            body: JSON.stringify({ error: "temporary approval read failure" }),
          });
          return;
        }
        await route.continue();
      },
    );
    await page.route(`**/api/routes/${routeIds[0]}`, async (route) => {
      if (failRouteRead) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "temporary route read failure" }),
        });
        return;
      }
      await route.continue();
    });
    await page.goto(`/routes/drafts/${currentDraftId}`);
    await expect(page.getByTestId("plan-status-error")).toBeVisible();
    const retryStatus = page.getByTestId("plan-status-error").getByRole("button");
    await expect(retryStatus).toBeEnabled();
    await retryStatus.click();
    await expect(retryStatus).toBeEnabled();
    await expect(page.getByTestId("plan-status-error")).toBeVisible();
    failApprovalRead = false;
    failRouteRead = false;
    await retryStatus.click();
    await expect(page.getByTestId("planning-draft-save-review")).toBeVisible();
    await expect(page.getByTestId("plan-status-error")).toHaveCount(0);
    await page.unroute(`**/api/import/route-plans/${plan.planId}/approval`);
    await page.unroute(`**/api/routes/${routeIds[0]}`);

    await page.goto(`/dispatch?view=traffic&planId=${plan.planId}`);
    await page.getByTestId("dispatch-plan-workflow-open").click();
    await expect(page.getByTestId("planning-draft-approve")).toBeVisible();

    const approvalResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/import/route-plans/${plan.planId}/approve`),
    );
    await page.getByTestId("planning-draft-approve").click();
    const approvalResponse = await approvalResponsePromise;
    expect(approvalResponse.status()).toBe(200);
    const approvalAfter = await approvalResponse.json();
    expect(approvalAfter).toMatchObject({
      planId: plan.planId,
      protected: true,
    });
    expect(approvalAfter.routes[0]).toMatchObject({
      routeId: routeIds[0],
      planId: plan.planId,
      draftId: currentDraftId,
      planRevision: savedRoute.body.planRevision,
      status: "optimized",
      vehicleId: vehicle.body.id,
      driverId: driver.body.id,
      approval: {
        approved: true,
        approvedByUserId: expect.any(String),
      },
    });
    expect(approvalRequests).toHaveLength(1);
    expect(dispatchRequests).toHaveLength(0);
    const approvalGetAfter = await api(
      page,
      `/api/import/route-plans/${plan.planId}/approval`,
    );
    expect(approvalGetAfter.status).toBe(200);
    expect(approvalGetAfter.body.routes[0].approval).toEqual(
      approvalAfter.routes[0].approval,
    );

    const persistedDraft = await planningDraft(page, currentDraftId);
    expect(persistedDraft).toMatchObject({
      planId: plan.planId,
      state: { step: 6 },
    });

    // Leave the wizard and resume from the persisted draft list.  The same
    // plan must be rendered, with exactly the original routes and stops.
    await page.goto("/routes/create");
    await expect(
      page.getByTestId(`button-draft-resume-${currentDraftId}`),
    ).toBeVisible();
    await page.getByTestId(`button-draft-resume-${currentDraftId}`).click();
    await expect(page).toHaveURL(
      new RegExp(`/routes/drafts/${currentDraftId}$`),
    );
    await expect(page.getByTestId("planning-draft-flow")).toHaveAttribute(
      "data-draft-id",
      currentDraftId,
    );
    // An approved draft resumes in Step7Dispatch, whose stable per-route
    // container is distinct from the Step7Adjust route card.
    await expect(
      page.getByTestId(`planning-draft-dispatch-${routeIds[0]}`),
    ).toHaveCount(routeIds.length);

    const routesAfterResume = await api(
      page,
      `/api/routes?organizationId=${organizationId}`,
    );
    expect(routesAfterResume.status).toBe(200);
    const persistedRoutes = routesAfterResume.body.filter(
      (route: { id: string }) => routeIds.includes(route.id),
    );
    expect(persistedRoutes).toHaveLength(routeIds.length);
    expect(persistedRoutes[0]).toMatchObject({
      id: routeIds[0],
      status: "optimized",
      handoffStatus: "pending",
      handoffVersion: null,
      handoffDriverId: null,
      sentAt: null,
      receivedAt: null,
      openedAt: null,
      acceptedAt: null,
      rejectedAt: null,
      rejectionReason: null,
    });
    const persistedRouteStops = (
      await Promise.all(routeIds.map((routeId) => routeStops(page, routeId)))
    ).flat();
    expect(persistedRouteStops).toHaveLength(importedStopIds.length);
    expect(persistedRouteStops.map((stop) => stop.id).sort()).toEqual(
      [...importedStopIds].sort(),
    );

    // Approval alone does not send or dispatch anything.  Do not invoke the
    // real handoff endpoint here: it emits an external webhook by design.
    expect(dispatchRequests).toHaveLength(0);
    expect((await api(page, `/api/routes/${routeIds[0]}`)).body).toMatchObject({
      planId: plan.planId,
      status: "optimized",
      handoffStatus: "pending",
      sentAt: null,
    });
  } finally {
    page.off("request", recordTransitionRequest);
    if (authFixture) await cleanupDisposableAuthFixture(authFixture);
  }
});
