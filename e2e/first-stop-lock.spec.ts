import { expect, test, type BrowserContext, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

/**
 * This regression deliberately owns its tenant.  The tenant has no contacts,
 * integrations, webhooks, or shared planning state.  It is important that the
 * route is created through the planner UI: the first-stop lock is a planner
 * action, not an administrative data repair.
 *
 * The selector contract used below is intentionally kept in the two helpers
 * near the bottom of this file.  The expected primary identifiers are:
 *
 *   - button-lock-first-stop-<stopId> / button-remove-first-stop-<stopId>
 *     (the route-detail toggle)
 *   - status-locked-first-stop-<stopId> (visible only on the locked stop)
 *
 * The role/name fallbacks make the test readable while the UI settles; the
 * test still requires one of these explicit lock controls to exist.
 */

test.setTimeout(240_000);

const DEPOT = {
  latitude: 59.3293,
  longitude: 18.0686,
};

const DEPOT_SNAPSHOT = {
  start: {
    address: "E2E first-stop-lock depot start, Stockholm",
    latitude: DEPOT.latitude,
    longitude: DEPOT.longitude,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: {
      provider: "nominatim",
      source: "nominatim",
      displayName: "E2E first-stop-lock depot start, Stockholm",
      query: "E2E first-stop-lock depot start, Stockholm",
    },
  },
  end: {
    address: "E2E first-stop-lock depot end, Stockholm",
    latitude: DEPOT.latitude,
    longitude: DEPOT.longitude,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: {
      provider: "nominatim",
      source: "nominatim",
      displayName: "E2E first-stop-lock depot end, Stockholm",
      query: "E2E first-stop-lock depot end, Stockholm",
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

async function provisionDisposableAuthFixture(
  suffix: string,
): Promise<DisposableAuthFixture> {
  const fixture: DisposableAuthFixture = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    email: `e2e-first-stop-lock-${suffix}@example.test`,
    password: `FirstStop-${randomUUID()}-Aa1!`,
  };

  const script = `
    import { randomBytes, scrypt } from "node:crypto";
    import { promisify } from "node:util";
    import { db, organizationsTable, pool, usersTable } from "@workspace/db";

    const scryptAsync = promisify(scrypt);
    const organizationId = process.env.E2E_FIRST_STOP_ORGANIZATION_ID;
    const userId = process.env.E2E_FIRST_STOP_USER_ID;
    const email = process.env.E2E_FIRST_STOP_EMAIL;
    const password = process.env.E2E_FIRST_STOP_PASSWORD;
    if (!organizationId || !userId || !email || !password) {
      throw new Error("First-stop lock fixture arguments are missing");
    }

    void (async () => {
      const salt = randomBytes(16).toString("hex");
      const derived = (await scryptAsync(password, salt, 64)) as Buffer;
      await db.insert(organizationsTable).values({
        id: organizationId,
        name: "E2E first-stop lock disposable organization",
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
        name: "E2E first-stop lock disposable admin",
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
        E2E_FIRST_STOP_ORGANIZATION_ID: fixture.organizationId,
        E2E_FIRST_STOP_USER_ID: fixture.userId,
        E2E_FIRST_STOP_EMAIL: fixture.email,
        E2E_FIRST_STOP_PASSWORD: fixture.password,
      },
    },
  );
  return fixture;
}

async function cleanupDisposableAuthFixture(
  fixture: DisposableAuthFixture,
): Promise<void> {
  /**
   * Keep dependent rows first so cleanup works after a failed assertion, a
   * partially completed optimization, or a route-preview apply.  This is
   * intentionally a best-effort tenant teardown at the call site; a primary
   * test failure is never replaced by a teardown failure.
   */
  const script = `
    import { pool } from "@workspace/db";

    const organizationId = process.env.E2E_FIRST_STOP_ORGANIZATION_ID;
    if (!organizationId) throw new Error("First-stop lock organization id is missing");

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
        E2E_FIRST_STOP_ORGANIZATION_ID: fixture.organizationId,
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

async function routeRecord(page: Page, routeId: string): Promise<any> {
  return assertStatus(await api(page, `/api/routes/${routeId}`), 200);
}

async function routeStops(page: Page, routeId: string): Promise<any[]> {
  const stops = assertStatus(
    await api(page, `/api/routes/${routeId}/stops`),
    200,
  );
  expect(Array.isArray(stops)).toBe(true);
  return [...stops].sort(
    (left, right) => (left.sequenceOrder ?? 0) - (right.sequenceOrder ?? 0),
  );
}

function firstStopLockTrigger(
  page: Page,
  stopId: string,
  locked: boolean,
): ReturnType<Page["locator"]> {
  return page
    .getByTestId(
      `${locked ? "button-remove" : "button-lock"}-first-stop-${stopId}`,
    );
}

function firstStopLockMarker(
  page: Page,
  stopId: string,
): ReturnType<Page["locator"]> {
  return page
    .getByTestId(`status-locked-first-stop-${stopId}`);
}

async function resumePersistedPlan(page: Page): Promise<void> {
  const resume = page.getByTestId("resumable-plan").getByRole("button", {
    name: /^(Fortsätt med sparad plan|Continue with saved plan)/i,
  });
  await expect(resume.or(page.getByTestId("planner-route")).first()).toBeVisible();
  if (await resume.count()) {
    await expect(resume).toBeVisible();
    await resume.click();
  }
  await expect(page.getByTestId("planner-route")).toHaveCount(1);
}

test("first-stop lock persists and constrains route-local reoptimization", async ({
  browser,
  page,
}, testInfo) => {
  await page.setViewportSize({ width: 1440, height: 1000 });
  page.setDefaultTimeout(20_000);
  page.setDefaultNavigationTimeout(20_000);

  const suffix = randomUUID().slice(0, 8);
  let fixture: DisposableAuthFixture | undefined;
  let foreignFixture: DisposableAuthFixture | undefined;
  let foreignContext: BrowserContext | undefined;
  let primaryFailure: unknown;
  let routeId: string | undefined;

  try {
    fixture = await provisionDisposableAuthFixture(suffix);
    await loginAsDisposableUser(page, fixture);

    const organizationId = fixture.organizationId;
    const vehicle = assertStatus(
      await api(page, "/api/vehicles", "POST", {
        organizationId,
        name: `E2E first-stop vehicle ${suffix}`,
        licensePlate: `FIRST-${suffix}`,
        vehicleType: "fossil",
        capacityKg: 1_000,
        capacityVolume: 50,
        isActive: true,
      }),
      201,
    );
    const driver = assertStatus(
      await api(page, "/api/drivers", "POST", {
        organizationId,
        name: `E2E first-stop driver ${suffix}`,
        vehicleId: vehicle.id,
        isActive: true,
        capacityKg: 1_000,
        capacityVolume: 50,
      }),
      201,
    );

    const stopCoordinates = [
      [59.334, 18.073],
      [59.342, 18.081],
      [59.326, 18.057],
    ] as const;
    const stopIds: string[] = [];
    for (const [index, [latitude, longitude]] of stopCoordinates.entries()) {
      const stop = assertStatus(
        await api(page, "/api/stops", "POST", {
          organizationId,
          address: `E2E first-stop lock ${suffix} stop ${index + 1}`,
          latitude,
          longitude,
          jobType: "delivery",
          weightKg: 10,
          volumeM3: 0.1,
          serviceDurationMin: 5,
          // No contacts, integrations, or webhook-dependent data are needed.
        }),
        201,
      );
      expect(stop.status).toBe("pending");
      expect(stop.contactName ?? null).toBeNull();
      expect(stop.contactEmail ?? null).toBeNull();
      expect(stop.contactPhone ?? null).toBeNull();
      stopIds.push(stop.id);
    }

    // The planner is the fixture helper: only the vehicle, driver, and three
    // pending stops are seeded through the API; route creation remains a real
    // browser optimization action.
    await page.goto("/planner");
    await page.reload();
    await expect(page.locator(`#v-${vehicle.id}`)).toBeVisible();
    await page.locator(`#v-${vehicle.id}`).click();
    for (const stopId of stopIds) {
      await expect(page.locator(`#s-${stopId}`)).toBeVisible();
      await page.locator(`#s-${stopId}`).click();
    }

    const optimizeResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith("/api/optimize"),
      { timeout: 120_000 },
    );
    await page.getByTestId("planner-generate-routes").click();
    const optimizeResponse = await optimizeResponsePromise;
    expect(optimizeResponse.status(), await optimizeResponse.text()).toBe(200);
    const optimizeResult = await optimizeResponse.json();
    expect(optimizeResult.routes).toHaveLength(1);
    routeId = optimizeResult.routes[0].routeId;

    const initialRoute = await routeRecord(page, routeId);
    expect(initialRoute).toMatchObject({
      status: "optimized",
      lockedFirstStopId: null,
      totalStops: 3,
    });
    const initialStops = await routeStops(page, routeId);
    expect(initialStops).toHaveLength(3);
    expect(initialStops.every((stop) => stop.status === "pending")).toBe(true);
    const secondStopId = initialStops[1].id as string;
    const initialOrder = initialStops.map((stop) => stop.id);

    const lockRevision = initialRoute.planRevision as number;
    await page.goto(`/routes/${routeId}`);
    await expect(
      page.getByTestId(`button-lock-first-stop-${secondStopId}`),
    ).toBeVisible();
    const lockRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "PUT" &&
        request.url().endsWith(`/api/routes/${routeId}/locked-first-stop`),
    );
    const lockResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith(`/api/routes/${routeId}/locked-first-stop`),
    );
    await firstStopLockTrigger(page, secondStopId, false).click();
    const lockRequest = await lockRequestPromise;
    expect(lockRequest.postDataJSON()).toMatchObject({
      stopId: secondStopId,
      planRevision: lockRevision,
    });
    const lockResponse = await lockResponsePromise;
    expect(lockResponse.status(), await lockResponse.text()).toBe(200);
    const lockedRoute = await routeRecord(page, routeId);
    expect(lockedRoute).toMatchObject({
      lockedFirstStopId: secondStopId,
      planRevision: lockRevision + 1,
    });
    await expect(firstStopLockMarker(page, secondStopId)).toBeVisible();

    // The route-local preview must include the manually chosen first stop even
    // though all three stops are still pending from the lifecycle's perspective.
    await page.goto("/planner");
    await page.reload();
    await resumePersistedPlan(page);
    await page.getByTestId(`button-reoptimization-menu-${routeId}`).click();
    await page.getByTestId(`preview-remaining-route-${routeId}`).click();
    await expect(page.getByTestId("reoptimization-dialog")).toBeVisible();
    const previewResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/routes/${routeId}/reoptimization/preview`),
      { timeout: 120_000 },
    );
    await page.getByTestId("button-create-route-preview").click();
    const previewResponse = await previewResponsePromise;
    expect(previewResponse.status(), await previewResponse.text()).toBe(200);
    const preview = await previewResponse.json();
    // lockedStopIds describes execution/status locks, not the route-owned
    // first-customer pin. Verify the actual proposed first position instead.
    expect(preview.optimizedStopIds[0]).toBe(secondStopId);
    expect([...preview.optimizedStopIds].sort()).toEqual(
      [...initialOrder].sort(),
    );
    const previewOrder = await page
      .getByTestId("remaining-route-preview-order")
      .locator("li")
      .evaluateAll((entries) =>
        entries.map((entry) => entry.getAttribute("data-stop-id") ?? ""),
      );
    expect(previewOrder[0]).toBe(secondStopId);

    const applyResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(`/api/routes/${routeId}/reoptimization/apply`),
      { timeout: 120_000 },
    );
    await page.getByTestId("apply-remaining-route-preview").click();
    const applyResponse = await applyResponsePromise;
    expect(applyResponse.status(), await applyResponse.text()).toBe(200);
    const applied = await applyResponse.json();
    expect(applied.optimizedStopIds[0]).toBe(secondStopId);

    const appliedRoute = await routeRecord(page, routeId);
    expect(appliedRoute.lockedFirstStopId).toBe(secondStopId);
    expect((await routeStops(page, routeId))[0].id).toBe(secondStopId);

    // Rehydrate the planner from the server, not from the pre-reload React
    // state.  Both the lock marker and customer sequence are persisted facts.
    await page.reload();
    await resumePersistedPlan(page);
    await page.goto(`/routes/${routeId}`);
    await expect(firstStopLockMarker(page, secondStopId)).toBeVisible();
    expect((await routeStops(page, routeId))[0].id).toBe(secondStopId);

    const unlockRevision = (await routeRecord(page, routeId))
      .planRevision as number;
    const unlockRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "PUT" &&
        request.url().endsWith(`/api/routes/${routeId}/locked-first-stop`),
    );
    const unlockResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT" &&
        response.url().endsWith(`/api/routes/${routeId}/locked-first-stop`),
    );
    await expect(
      page.getByTestId(`button-remove-first-stop-${secondStopId}`),
    ).toBeVisible();
    await firstStopLockTrigger(page, secondStopId, true).click();
    const unlockRequest = await unlockRequestPromise;
    expect(unlockRequest.postDataJSON()).toMatchObject({
      stopId: null,
      planRevision: unlockRevision,
    });
    const unlockResponse = await unlockResponsePromise;
    expect(unlockResponse.status(), await unlockResponse.text()).toBe(200);
    expect((await routeRecord(page, routeId)).lockedFirstStopId).toBeNull();
    await expect(firstStopLockMarker(page, secondStopId)).toHaveCount(0);

    await page.reload();
    await expect(firstStopLockMarker(page, secondStopId)).toHaveCount(0);
    expect((await routeRecord(page, routeId)).lockedFirstStopId).toBeNull();

    // The endpoint uses route revision CAS, and the existing reorder contract
    // rejects malformed stop lists before any planning mutation.
    const currentRoute = await routeRecord(page, routeId);
    const invalidReorder = await api(
      page,
      `/api/routes/${routeId}/reorder-stops`,
      "PUT",
      {
        stopIds: [secondStopId, secondStopId, initialStops[2].id],
        planRevision: currentRoute.planRevision,
      },
    );
    expect(invalidReorder.status).toBe(400);
    const staleLock = await api(
      page,
      `/api/routes/${routeId}/locked-first-stop`,
      "PUT",
      {
        stopId: secondStopId,
        planRevision: Math.max(0, currentRoute.planRevision - 1),
      },
    );
    expect(staleLock.status).toBe(409);
    expect((await routeRecord(page, routeId)).lockedFirstStopId).toBeNull();

    // A real route in another disposable tenant proves that the lock endpoint
    // does not become a cross-tenant route-id oracle.
    foreignFixture = await provisionDisposableAuthFixture(`${suffix}-foreign`);
    const baseURL = testInfo.project.use.baseURL;
    if (typeof baseURL !== "string") {
      throw new Error(
        "Playwright project baseURL is required for cross-tenant setup",
      );
    }
    foreignContext = await browser.newContext({
      baseURL,
      ignoreHTTPSErrors: testInfo.project.use.ignoreHTTPSErrors === true,
      viewport: { width: 1280, height: 900 },
    });
    const foreignPage = await foreignContext.newPage();
    await loginAsDisposableUser(foreignPage, foreignFixture);
    const foreignVehicle = assertStatus(
      await api(foreignPage, "/api/vehicles", "POST", {
        organizationId: foreignFixture.organizationId,
        name: `E2E foreign first-stop vehicle ${suffix}`,
        licensePlate: `FOREIGN-${suffix}`,
        vehicleType: "fossil",
        capacityKg: 1_000,
        capacityVolume: 50,
        isActive: true,
      }),
      201,
    );
    const foreignRoute = assertStatus(
      await api(foreignPage, "/api/routes", "POST", {
        organizationId: foreignFixture.organizationId,
        name: `E2E foreign first-stop route ${suffix}`,
        date: "2099-06-17T00:00:00.000Z",
        vehicleId: foreignVehicle.id,
        status: "draft",
        totalStops: 0,
      }),
      201,
    );
    const crossTenantLock = await api(
      page,
      `/api/routes/${foreignRoute.id}/locked-first-stop`,
      "PUT",
      {
        stopId: null,
        planRevision: foreignRoute.planRevision ?? 0,
      },
    );
    expect(crossTenantLock.status).toBe(404);
  } catch (error) {
    primaryFailure = error;
    throw error;
  } finally {
    await foreignContext?.close();
    if (fixture) {
      try {
        await cleanupDisposableAuthFixture(fixture);
      } catch (cleanupError) {
        if (!primaryFailure) throw cleanupError;
        console.warn(
          "Primary first-stop-lock failure preserved; fixture cleanup failed",
          cleanupError,
        );
      }
    }
    if (foreignFixture) {
      try {
        await cleanupDisposableAuthFixture(foreignFixture);
      } catch (cleanupError) {
        if (!primaryFailure) throw cleanupError;
        console.warn(
          "Primary first-stop-lock failure preserved; foreign cleanup failed",
          cleanupError,
        );
      }
    }
  }
});
