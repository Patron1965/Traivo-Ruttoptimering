import { expect, test, type Page, type Request } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

/**
 * This regression deliberately uses a disposable tenant.  It has no webhook
 * rows, no integration rows, no driver phone, and no driver depot
 * coordinates.  The only depot available to route review is the immutable
 * organization depot snapshot captured by optimization.
 *
 * The browser journey is intentionally narrow:
 *
 *   mixed import + address correction
 *     -> conserved rows
 *     -> resource selection
 *     -> final validation
 *     -> approval
 *     -> one controlled dispatch failure and retry
 *     -> live reopen
 *
 * The sent-draft review assertion is kept in this same journey because the
 * route must be in_progress for review=1 to exercise the read-only guard.
 */

test.setTimeout(240_000);

const DEPOT = {
  latitude: 59.3293,
  longitude: 18.0686,
};

const DEPOT_SNAPSHOT = {
  start: {
    address: "E2E immutable depot start, Stockholm",
    latitude: DEPOT.latitude,
    longitude: DEPOT.longitude,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: {
      provider: "nominatim",
      source: "nominatim",
      displayName: "E2E immutable depot start, Stockholm",
      query: "E2E immutable depot start, Stockholm",
    },
  },
  end: {
    address: "E2E immutable depot end, Stockholm",
    latitude: DEPOT.latitude,
    longitude: DEPOT.longitude,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: {
      provider: "nominatim",
      source: "nominatim",
      displayName: "E2E immutable depot end, Stockholm",
      query: "E2E immutable depot end, Stockholm",
    },
  },
} as const;

type ApiResult = {
  status: number;
  body: any;
};

type DisposableAuthFixture = {
  organizationId: string;
  userId: string;
  email: string;
  password: string;
};

type FixtureIds = {
  vehicleIds: string[];
  driverIds: string[];
  stopIds: string[];
  routeIds: string[];
  draftIds: string[];
};

const execFileAsync = promisify(execFile);

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

function assertStatus(result: ApiResult, expected: number): any {
  expect(result.status, JSON.stringify(result.body)).toBe(expected);
  return result.body;
}

/**
 * Keep this fixture aligned with planning-draft-flow.spec.ts: one row already
 * has coordinates and one row requires a candidate correction.  The source
 * order numbers make row identity observable after import.
 */
function mixedImportFixture(
  suffix: string,
  planningDate: string,
): {
  name: string;
  mimeType: string;
  buffer: Buffer;
} {
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
      `E2E-guided-${suffix}-1`,
      `Guided known ${suffix}`,
      `E2E guided known address ${suffix}`,
      "59.3297",
      "18.0689",
      planningDate,
      "08:00",
      "11:00",
      "5",
    ],
    [
      `E2E-guided-${suffix}-2`,
      `Guided uncertain ${suffix}`,
      `E2E guided uncertain address ${suffix}`,
      "",
      "",
      planningDate,
      "08:00",
      "11:00",
      "5",
    ],
  ];
  return {
    name: `guided-planning-${suffix}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      `\uFEFF${headers.join(";")}\r\n${rows
        .map((row) => row.join(";"))
        .join("\r\n")}`,
      "utf8",
    ),
  };
}

function draftIdFromUrl(url: string): string {
  const match = url.match(/\/routes\/drafts\/([0-9a-f-]{36})(?:[/?#]|$)/i);
  if (!match) throw new Error(`Expected a planning draft URL, got ${url}`);
  return match[1];
}

async function provisionDisposableAuthFixture(
  suffix: string,
): Promise<DisposableAuthFixture> {
  const fixture: DisposableAuthFixture = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    email: `e2e-guided-${suffix}@example.test`,
    password: `Guided-${randomUUID()}-Aa1!`,
  };

  const script = `
    import { randomBytes, scrypt } from "node:crypto";
    import { promisify } from "node:util";
    import { db, organizationsTable, pool, usersTable } from "@workspace/db";

    const scryptAsync = promisify(scrypt);
    const organizationId = process.env.E2E_GUIDED_ORGANIZATION_ID;
    const userId = process.env.E2E_GUIDED_USER_ID;
    const email = process.env.E2E_GUIDED_EMAIL;
    const password = process.env.E2E_GUIDED_PASSWORD;
    if (!organizationId || !userId || !email || !password) {
      throw new Error("Guided planning fixture arguments are missing");
    }

    void (async () => {
      const salt = randomBytes(16).toString("hex");
      const derived = (await scryptAsync(password, salt, 64)) as Buffer;
      await db.insert(organizationsTable).values({
        id: organizationId,
        name: "E2E guided planning disposable organization",
        email,
        // A verified organization depot is the immutable route-plan source.
        // The driver created by the test intentionally has no coordinates.
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
        name: "E2E guided planning disposable admin",
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
        E2E_GUIDED_ORGANIZATION_ID: fixture.organizationId,
        E2E_GUIDED_USER_ID: fixture.userId,
        E2E_GUIDED_EMAIL: fixture.email,
        E2E_GUIDED_PASSWORD: fixture.password,
      },
    },
  );
  return fixture;
}

async function cleanupDisposableAuthFixture(
  fixture: DisposableAuthFixture,
): Promise<void> {
  /**
   * The fixture starts with an empty tenant, and the workflow only creates
   * routes, stops, resources, a draft, an approval row, and a route
   * acknowledgement.  Delete the dependent rows first so cleanup remains
   * safe even after the route has been sent.
   */
  const script = `
    import { pool } from "@workspace/db";

    const organizationId = process.env.E2E_GUIDED_ORGANIZATION_ID;
    if (!organizationId) throw new Error("Guided organization id is missing");

    void (async () => {
      const statements = [
        "UPDATE routes SET optimization_frozen = false WHERE organization_id = $1",
        "UPDATE stops SET locked_vehicle_id = NULL, locked_driver_id = NULL, locked_service_start_at = NULL WHERE organization_id = $1",
        "UPDATE routes SET status = 'cancelled' WHERE organization_id = $1 AND status <> 'cancelled'",
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
        E2E_GUIDED_ORGANIZATION_ID: fixture.organizationId,
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

async function expectImportCount(
  page: Page,
  id: string,
  count: number,
): Promise<void> {
  if (!(await page.getByTestId("import-count-inlästa").isVisible())) {
    await page.getByRole("button", { name: "Importstatistik", exact: true }).click();
  }
  const testId = (id === "Åtgärd krävs" ? "Åtgärd" : id).toLocaleLowerCase(
    "sv-SE",
  );
  await expect(
    page.locator(`[data-testid="import-count-${testId}"]`),
  ).toContainText(String(count));
}

async function routeRecord(page: Page, routeId: string): Promise<any> {
  return assertStatus(await api(page, `/api/routes/${routeId}`), 200);
}

test("guided planning conserves corrected rows and safely reopens a sent plan", async ({
  page,
}) => {
  page.setDefaultTimeout(20_000);
  await page.setViewportSize({ width: 1440, height: 1000 });

  const suffix = randomUUID().slice(0, 8);
  const planningDate = "2099-06-17";
  const draftName = `E2E guided planning ${suffix}`;
  const candidateId = `e2e-guided-candidate-${suffix}`;
  const candidateLatitude = 59.3299;
  const candidateLongitude = 18.0691;
  const fixture: FixtureIds = {
    vehicleIds: [],
    driverIds: [],
    stopIds: [],
    routeIds: [],
    draftIds: [],
  };
  let authFixture: DisposableAuthFixture | undefined;
  let draftId: string | undefined;
  let planId: string | undefined;
  let organizationId: string | undefined;
  let dispatchAttempts = 0;
  const dispatchRequests: Request[] = [];
  const approvalRequests: Request[] = [];

  const recordTransitionRequest = (request: Request) => {
    if (request.method() !== "POST") return;
    if (
      request.url().includes("/api/import/route-plans/") &&
      request.url().endsWith("/approve")
    ) {
      approvalRequests.push(request);
    }
    if (
      request.url().includes("/api/routes/") &&
      request.url().endsWith("/dispatch")
    ) {
      dispatchRequests.push(request);
    }
  };
  page.on("request", recordTransitionRequest);

  authFixture = await provisionDisposableAuthFixture(suffix);

  // Only the external geocoder is stubbed. The real import, optimizer,
  // approval, and dispatch APIs remain under test.
  await page.route("**/api/geocode/batch", async (route) => {
    const body = route.request().postDataJSON() as {
      addresses?: Array<{ id?: string; address?: string }>;
    };
    const addresses = body.addresses ?? [];
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
              displayName: `E2E guided corrected address ${suffix}`,
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

  try {
    await loginAsDisposableUser(page, authFixture);
    organizationId = authFixture.organizationId;

    // The disposable tenant deliberately has no webhook/integration setup.
    const hooks = await api(
      page,
      `/api/webhooks?organizationId=${organizationId}`,
    );
    expect(hooks.status).toBe(200);
    expect(hooks.body).toEqual([]);

    const vehicle = assertStatus(
      await api(page, "/api/vehicles", "POST", {
        organizationId,
        name: `E2E guided vehicle ${suffix}`,
        licensePlate: `GUIDED-${suffix}`,
        vehicleType: "fossil",
        capacityKg: 1_000,
        capacityVolume: 50,
        isActive: true,
        // No contact details or depot coordinates: dispatch must report
        // missing-phone without sending to an external provider.
        driver: {
          name: `E2E guided phonefree driver ${suffix}`,
          capacityKg: 1_000,
          capacityVolume: 50,
        },
      }),
      201,
    );
    fixture.vehicleIds.push(vehicle.id);

    const driver = vehicle.resourceProfile;
    expect(driver?.id).toBeTruthy();
    expect(driver.vehicleId).toBe(vehicle.id);
    fixture.driverIds.push(driver.id);
    // Real driver login, isolated to this disposable tenant. Reuse only this
    // fixture's password hash, never a customer or bootstrap identity.
    const driverEmail = `driver-${authFixture.email}`;
    await execFileAsync("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
      import { pool } from "@workspace/db";
      (async () => { try {
        const result = await pool.query(
          "INSERT INTO users (id,organization_id,name,email,role,password_hash,driver_profile_id) SELECT $1,organization_id,'Synthetic acceptance driver',$2,'driver',password_hash,$3 FROM users WHERE id=$4 AND organization_id=$5 RETURNING id",
          [process.env.TEST_USER,process.env.TEST_EMAIL,process.env.TEST_DRIVER,process.env.TEST_OWNER,process.env.TEST_ORG]);
        if (result.rowCount !== 1) throw new Error("Missing disposable owner");
      } finally { await pool.end(); } })();
    `], { env: { ...process.env, TEST_USER: randomUUID(), TEST_EMAIL: driverEmail,
      TEST_DRIVER: driver.id, TEST_OWNER: authFixture.userId, TEST_ORG: organizationId } });
    expect(driver.phone ?? null).toBeNull();
    expect(driver.startLatitude ?? null).toBeNull();
    expect(driver.startLongitude ?? null).toBeNull();
    expect(driver.endLatitude ?? null).toBeNull();
    expect(driver.endLongitude ?? null).toBeNull();

    await page.getByTestId("input-draft-name").fill(draftName);
    await page.getByTestId("input-draft-date").fill(planningDate);
    await page.getByTestId("button-draft-continue").click();
    await page.getByTestId("button-draft-start-import").click();
    await expect(page).toHaveURL(/\/routes\/drafts\/[0-9a-f-]{36}$/i);
    draftId = draftIdFromUrl(page.url());
    fixture.draftIds.push(draftId);

    await expect(page.getByTestId("import-file-input")).toBeAttached();
    await page
      .getByTestId("import-file-input")
      .setInputFiles(mixedImportFixture(suffix, planningDate));

    // Parsing automatically opens mapping. Advance mapping -> review ->
    // addresses exactly once each; there is no Next action on addresses.
    await test.step("Apply column mapping", async () => {
      await page.getByRole("button", { name: /^(Nästa|Next)$/ }).click();
    });
    await test.step("Continue row review to address selection", async () => {
      await page.getByRole("button", { name: /^(Nästa|Next)$/ }).click();
      await expect(
        page.getByTestId(`planning-draft-geocode-candidate-${candidateId}`),
      ).toBeVisible();
    });
    await expect(
      page.getByTestId(`planning-draft-geocode-candidate-${candidateId}`),
    ).toBeVisible();
    await expectImportCount(page, "inlästa", 2);
    await expectImportCount(page, "Klara", 1);
    await expectImportCount(page, "Åtgärd krävs", 1);
    await expectImportCount(page, "Avvisade", 0);
    await expectImportCount(page, "sparade", 0);

    await page
      .getByTestId(`planning-draft-geocode-candidate-${candidateId}`)
      .click();
    await expectImportCount(page, "Klara", 2);
    await expectImportCount(page, "Åtgärd krävs", 0);
    await expect(page.getByTestId("planning-draft-save-stops")).toBeEnabled();

    const importResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/stops/import"),
    );
    await page.getByTestId("planning-draft-save-stops").click();
    const importResult = await importResponse;
    expect(importResult.status()).toBe(201);
    const importBody = await importResult.json();
    expect(importBody.receivedRowCount).toBe(2);
    expect(importBody.savedRowCount).toBe(2);
    expect(importBody.stops).toHaveLength(2);
    fixture.stopIds.push(
      ...importBody.stops.map((stop: { id: string }) => stop.id),
    );
    expect(
      importBody.stops
        .map((stop: { externalRef: string }) => stop.externalRef)
        .sort(),
    ).toEqual([`E2E-guided-${suffix}-1`, `E2E-guided-${suffix}-2`]);
    expect(
      importBody.stops.some(
        (stop: { latitude: number; longitude: number }) =>
          Math.abs(stop.latitude - candidateLatitude) < 0.000001 &&
          Math.abs(stop.longitude - candidateLongitude) < 0.000001,
      ),
    ).toBe(true);
    await expectImportCount(page, "inlästa", 2);
    await expectImportCount(page, "sparade", 2);

    const pair = page.getByTestId(
      `planning-draft-vehicle-pair-${vehicle.id}-${driver.id}`,
    );
    await expect(pair).toBeVisible();
    await pair.click();

    const planRequests: Record<string, unknown>[] = [];
    const recordPlanRequest = (request: Request) => {
      if (
        request.method() === "POST" &&
        request.url().includes("/api/import/route-plans")
      ) {
        planRequests.push(request.postDataJSON() as Record<string, unknown>);
      }
    };
    page.on("request", recordPlanRequest);
    const planResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().includes("/api/import/route-plans"),
    );
    await page.getByTestId("planning-draft-optimize").click();
    const planResult = await planResponse;
    page.off("request", recordPlanRequest);
    expect(planResult.status()).toBe(200);
    const plan = await planResult.json();
    planId = plan.planId;
    expect(planId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(plan.routes).toHaveLength(1);
    expect(plan.routes[0].stopCount).toBe(2);
    expect(plan.unassignedStopIds).toEqual([]);
    expect(planRequests).toHaveLength(1);
    expect(planRequests[0].draftId).toBe(draftId);
    expect(planRequests[0].stopIds).toEqual(
      expect.arrayContaining(fixture.stopIds),
    );
    expect(planRequests[0].pairs).toEqual([
      { vehicleId: vehicle.id, driverId: driver.id },
    ]);

    const routeId = plan.routes[0].routeId as string;
    fixture.routeIds.push(routeId);
    const optimizedRoute = await routeRecord(page, routeId);
    expect(optimizedRoute).toMatchObject({
      status: "optimized",
      manualReviewRequired: true,
      depotSnapshot: {
        start: {
          address: DEPOT_SNAPSHOT.start.address,
          latitude: DEPOT.latitude,
          longitude: DEPOT.longitude,
          verifiedAt: expect.any(String),
        },
        end: {
          address: DEPOT_SNAPSHOT.end.address,
          latitude: DEPOT.latitude,
          longitude: DEPOT.longitude,
          verifiedAt: expect.any(String),
        },
      },
    });
    // The immutable plan depot, not mutable driver metadata, powers review.
    expect(optimizedRoute.depotSnapshot.start.latitude).toBe(DEPOT.latitude);
    expect(optimizedRoute.depotSnapshot.start.longitude).toBe(DEPOT.longitude);

    const approvalBefore = assertStatus(
      await api(page, `/api/import/route-plans/${planId}/approval`),
      200,
    );
    expect(approvalBefore.routes).toHaveLength(1);
    expect(approvalBefore.routes[0]).toMatchObject({
      routeId,
      planId,
      draftId,
      status: "optimized",
      approval: {
        approved: false,
      },
    });

    // Step 7 first previews the complete immutable draft. Saving is a
    // separate, explicitly reviewed action bound to that exact digest.
    await page.getByRole("button", { name: /(?:Move|Flytta).*?(?:down|nedåt)/i }).first().click();
    const adjustmentPreview = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/import/route-adjustments/preview"),
    );
    await page.getByTestId("planning-draft-save-review").click();
    const previewResponse = await adjustmentPreview;
    expect(previewResponse.status()).toBe(200);
    expect((await previewResponse.json()).canApply).toBe(true);
    await expect(page.getByRole("region", { name: "Granska hela planändringen" })).toBeVisible();
    await page.getByLabel(/Jag har granskat hela förslaget/).check();
    const adjustmentResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/import/route-adjustments"),
    );
    await page.getByTestId("planning-draft-save-review").click();
    expect((await adjustmentResponse).status()).toBe(200);
    await expect(page).toHaveURL(
      new RegExp(`/dispatch\\?view=traffic&planId=${planId}`),
    );
    await page.getByTestId("dispatch-plan-workflow-open").click();
    await expect(page.getByTestId("dispatch-plan-workflow-dialog")).toBeVisible();
    await expect(page.getByTestId("planning-draft-approve")).toBeVisible();
    expect(approvalRequests).toHaveLength(0);
    expect(dispatchRequests).toHaveLength(0);

    const approvalResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/import/route-plans/${planId}/approve`),
    );
    await page.getByTestId("planning-draft-approve").click();
    expect((await approvalResponse).status()).toBe(200);
    expect(approvalRequests).toHaveLength(1);
    expect(dispatchRequests).toHaveLength(0);

    const approvalAfter = assertStatus(
      await api(page, `/api/import/route-plans/${planId}/approval`),
      200,
    );
    expect(approvalAfter.routes[0]).toMatchObject({
      routeId,
      status: "optimized",
      approval: {
        approved: true,
        approvedByUserId: expect.any(String),
      },
    });
    const reviewedRoute = await routeRecord(page, routeId);
    expect(reviewedRoute.status).toBe("optimized");
    expect(reviewedRoute.depotSnapshot).toEqual(
      expect.objectContaining({
        start: expect.objectContaining({
          latitude: DEPOT.latitude,
          longitude: DEPOT.longitude,
        }),
        end: expect.objectContaining({
          latitude: DEPOT.latitude,
          longitude: DEPOT.longitude,
        }),
      }),
    );

    await expect(
      page.getByTestId(`planning-draft-dispatch-${routeId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`planning-draft-send-${routeId}`),
    ).toBeVisible();

    // Fail only the first browser dispatch request. The retry reaches the
    // real endpoint; missing_phone is expected and does not undo publication.
    await page.route(`**/api/routes/${routeId}/dispatch`, async (route) => {
      dispatchAttempts += 1;
      if (dispatchAttempts === 1) {
        await route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "Controlled E2E dispatch failure" }),
        });
        return;
      }
      await route.continue();
    });

    const firstDispatchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/routes/${routeId}/dispatch`),
    );
    await page.getByTestId(`planning-draft-send-${routeId}`).click();
    expect((await firstDispatchResponse).status()).toBe(503);
    await expect(
      page.getByTestId(`planning-draft-send-${routeId}`),
    ).toBeVisible();

    const retryDispatchResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/routes/${routeId}/dispatch`),
    );
    await page.getByTestId(`planning-draft-send-${routeId}`).click();
    expect((await retryDispatchResponse).status()).toBe(200);
    expect(dispatchAttempts).toBe(2);
    expect(dispatchRequests).toHaveLength(2);
    await expect(
      page.getByTestId(`planning-draft-resend-${routeId}`),
    ).toBeVisible();

    const sentRoute = await routeRecord(page, routeId);
    expect(sentRoute).toMatchObject({
      status: "in_progress",
      handoffStatus: "sent",
      handoffDriverId: driver.id,
      handoffVersion: sentRoute.planRevision,
    });
    expect(sentRoute.sentAt).toBeTruthy();
    expect(sentRoute.depotSnapshot).toEqual(reviewedRoute.depotSnapshot);

    const driverContext = await page.context().browser()!.newContext({
      viewport: { width: 402, height: 874 }, permissions: ["geolocation"],
      geolocation: { ...DEPOT, accuracy: 5 },
    });
    try {
      const mobile = await driverContext.newPage();
      mobile.setDefaultTimeout(30_000);
      await mobile.goto(process.env.E2E_DRIVER_URL ?? "http://127.0.0.1:18809/", { waitUntil: "domcontentloaded" });
      await mobile.getByPlaceholder("namn@foretag.se").fill(driverEmail);
      await mobile.getByPlaceholder("Ditt lösenord").fill(authFixture.password);
      await mobile.getByText("Logga in", { exact: true }).click();
      await mobile.getByText("Godkänn rutt", { exact: true }).click();
      await mobile.getByText("Bekräfta", { exact: true }).click();
      await expect.poll(async () => (await routeRecord(page, routeId)).handoffStatus).toBe("accepted");
      // Outcomes are inside the report sheet in the current driver UI.
      await mobile.locator('[data-testid^="report-stop-"]').first().click();
      const completedButton = mobile.locator('[data-testid^="report-completed-"]').first();
      await expect(completedButton).toBeVisible();
      const completedId = (await completedButton.getAttribute("data-testid"))!.replace("report-completed-", "");
      const stopForGps = (await api(page, `/api/stops/${completedId}`)).body;
      await driverContext.setGeolocation({ latitude: stopForGps.latitude, longitude: stopForGps.longitude, accuracy: 5 });
      await completedButton.click();
      await mobile.getByTestId("save-stop-report").click();
      await expect.poll(async () => {
        const result = await api(page, `/api/stops/${completedId}`);
        return result.body.status;
      }, { timeout: 60_000 }).toBe("completed");
      await expect(mobile.getByRole("button", { name: "Till ruttöversikten", exact: true })
        .locator("..").getByText("Synkat med trafikledningen", { exact: true })).toBeVisible();
      await mobile.getByRole("button", { name: "Till ruttöversikten", exact: true }).click();
      // Expo navigation is asynchronous; reloading the proof screen while its
      // back navigation is still committing can abort the document request.
      await expect(mobile).not.toHaveURL(/\/proof\//);
      await expect(mobile.getByTestId(`stop-card-${completedId}`)).toBeVisible();
      await mobile.reload();
      await expect(mobile.getByTestId(`stop-card-${completedId}`)).toContainText("Genomfört");
      // A revised working version must remain invisible until explicit review
      // and redispatch; the new version then requires a fresh driver decision.
      const beforeRevision = await routeRecord(page, routeId);
      assertStatus(await api(page, `/api/routes/${routeId}`, "PUT", {
        name: `${beforeRevision.name} revised`, planRevision: beforeRevision.planRevision,
      }), 200);
      await mobile.reload();
      expect((await routeRecord(page, routeId)).handoffVersion).toBe(beforeRevision.handoffVersion);
      await expect(mobile.getByText(`${beforeRevision.name} revised`, { exact: true })).toHaveCount(0);
      await page.goto(`/dispatch?view=traffic&planId=${planId}`);
      await page.getByTestId("dispatch-plan-workflow-open").click();
      await page.getByTestId("planning-draft-approve").click();
      const redispatch = page.waitForResponse(r => r.url().endsWith(`/api/routes/${routeId}/dispatch`) && r.request().method() === "POST");
      await page.getByTestId(`planning-draft-send-${routeId}`).click();
      expect((await redispatch).status()).toBe(200);
      // Deliver the automatic "opened" acknowledgement after acceptance.
      // It must neither dismiss a pending decision nor revoke a confirmed one.
      let releaseOpened!: () => void;
      let openedReady!: () => void;
      const openedHeld = new Promise<void>(resolve => { openedReady = resolve; });
      const openedRelease = new Promise<void>(resolve => { releaseOpened = resolve; });
      const handoffUrl = `**/api/routes/${routeId}/handoff`;
      await mobile.route(handoffUrl, async intercepted => {
        if (intercepted.request().postDataJSON()?.status !== "opened") {
          await intercepted.continue();
          return;
        }
        const response = await intercepted.fetch();
        openedReady();
        await openedRelease;
        await intercepted.fulfill({ response });
      });
      try {
        await mobile.reload();
        await expect(mobile.locator('[data-testid^="report-stop-"]')).toHaveCount(0);
        await Promise.race([
          openedHeld,
          new Promise<never>((_, reject) => {
            const timer = setTimeout(() => reject(new Error("Automatic opened acknowledgement was not received")), 30_000);
            timer.unref();
            void openedHeld.then(() => clearTimeout(timer));
          }),
        ]);
        await mobile.getByText("Godkänn rutt", { exact: true }).click();
        await expect(mobile.getByText("Bekräfta", { exact: true })).toBeVisible();
        const openedDelivered = mobile.waitForResponse(response =>
          response.url().endsWith(`/api/routes/${routeId}/handoff`)
          && response.request().postDataJSON()?.status === "opened");
        await mobile.getByText("Bekräfta", { exact: true }).click();
        await expect.poll(async () => (await routeRecord(page, routeId)).handoffStatus).toBe("accepted");
        await expect(mobile.locator('[data-testid^="report-stop-"]').first()).toBeVisible();
        releaseOpened();
        expect((await openedDelivered).status()).toBe(200);
        await expect(mobile.locator('[data-testid^="report-stop-"]').first()).toBeVisible();
        await expect(mobile.getByText("Godkänn rutt", { exact: true })).toHaveCount(0);
      } finally {
        releaseOpened();
        await mobile.unroute(handoffUrl);
      }
      await mobile.locator('[data-testid^="report-stop-"]').first().click();
      const nextButton = mobile.locator('[data-testid^="report-completed-"]').first();
      await expect(nextButton).toBeVisible();
      const nextId = (await nextButton.getAttribute("data-testid"))!.replace("report-completed-", "");
      const nextGps = (await api(page, `/api/stops/${nextId}`)).body;
      await driverContext.setGeolocation({ latitude: nextGps.latitude, longitude: nextGps.longitude, accuracy: 5 });
      await nextButton.click();
      await mobile.getByTestId("save-stop-report").click();
      await expect.poll(async () => (await api(page, `/api/stops/${nextId}`)).body.status, { timeout: 60_000 }).toBe("completed");
      expect((await api(page, `/api/stops/${completedId}`)).body.status).toBe("completed");
      await expect(mobile.getByRole("button", { name: "Till ruttöversikten", exact: true })
        .locator("..").getByText("Synkat med trafikledningen", { exact: true })).toBeVisible({ timeout: 30_000 });
      await mobile.getByRole("button", { name: "Till ruttöversikten", exact: true }).click();
      await expect(mobile.getByTestId(`stop-card-${nextId}`)).toContainText("Genomfört");
      await mobile.screenshot({ path: "/tmp/planner-driver-completed.png" });
    } finally {
      await driverContext.close();
    }

    // A sent draft opened explicitly for review must be read-only. The
    // fieldset remains rendered for inspection, but its save/adjust controls
    // are disabled by the route lifecycle state.
    await page.goto(`/routes/drafts/${draftId}?review=1`);
    await expect(page.getByTestId("planning-draft-flow")).toHaveAttribute(
      "data-draft-id",
      draftId,
    );
    await expect(page.getByTestId("plan-review-read-only")).toBeVisible();
    await expect(page.getByTestId("planning-draft-save-review")).toBeDisabled();

    // The dispatch handoff is complete despite the intentionally phone-free
    // recipient. Reopen the same plan in live mode and verify it survives a
    // browser reload.
    await page.goto(`/dispatch?view=live&planId=${planId}`);
    await expect(page).toHaveURL(
      new RegExp(`view=live.*planId=${planId}|planId=${planId}.*view=live`),
    );
    await expect(page.getByTestId("dispatch-split")).toBeVisible();
    await expect(page.getByTestId("dispatch-gantt-row")).toHaveCount(1);
    await expect(page.getByTestId("dispatch-gantt-row")).toHaveAttribute(
      "data-route-row-id",
      routeId,
    );

    // The current scope picker resolves an unambiguous single open plan back
    // into the URL. Clearing it must not substitute another route or lose live mode.
    await page.getByTestId("button-clear-dispatch-scope").click();
    await expect.poll(() => {
      const params = new URL(page.url()).searchParams;
      return { view: params.get("view"), planId: params.get("planId") };
    }).toEqual({ view: "live", planId });
    await expect(page.getByTestId("dispatch-split")).toBeVisible();
    const globalRoutes = assertStatus(
      await api(page, `/api/routes?organizationId=${organizationId}`),
      200,
    );
    expect(globalRoutes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: routeId,
          status: "in_progress",
        }),
      ]),
    );
    expect(
      globalRoutes.filter(
        (route: { status: string }) =>
          !["optimized", "in_progress", "draft"].includes(route.status),
      ),
    ).toHaveLength(0);
    await expect(page.getByTestId("dispatch-gantt-row")).toHaveCount(1);
    await expect(page.getByTestId("dispatch-gantt-row")).toHaveAttribute(
      "data-route-row-id",
      routeId,
    );

    // Reopen the explicit plan after the global-board escape and verify it
    // remains addressable and survives a browser reload.
    await page.goto(`/dispatch?view=live&planId=${planId}`);
    await expect(page.getByTestId("dispatch-split")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("dispatch-split")).toBeVisible();
    expect((await routeRecord(page, routeId)).handoffStatus).toBe("accepted");
    await page.getByTestId("dispatch-return-to-review").click();
    await expect(page).toHaveURL(new RegExp(`/routes/drafts/${draftId}\\?review=1$`));
    await expect(page.getByTestId("plan-review-read-only")).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("plan-review-read-only")).toBeVisible();
    await expect(page.getByTestId("planning-draft-save-review")).toBeDisabled();
    expect((await routeRecord(page, routeId)).handoffStatus).toBe("accepted");
  } finally {
    page.off("request", recordTransitionRequest);
    // A test timeout can close the page before finally runs.  Each route
    // teardown is best-effort and must never prevent tenant cleanup below.
    try {
      await page.unroute("**/api/geocode/batch");
    } catch {
      // The page/context may already be closed after a timeout.
    }
    try {
      await page.unroute(
        `**/api/routes/${fixture.routeIds[0] ?? "*"}/dispatch`,
      );
    } catch {
      // The page/context may already be closed after a timeout.
    }
    if (authFixture) {
      await cleanupDisposableAuthFixture(authFixture);
    }
  }
});
