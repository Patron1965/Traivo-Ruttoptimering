import {
  expect,
  type Page,
  type Request,
} from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import { authenticatedOrganizationId, login, test } from "./auth";

/**
 * Acceptance coverage for the planning-inputs contract.
 *
 * The fixture creates the disposable stops/resources/drafts through the real
 * authenticated API, then resumes the real wizard and uses its controls for
 * review, approval, and searching.  No application API or optimizer is
 * mocked.  The handoff endpoint is intentionally not invoked: dispatch emits
 * an external webhook, while this spec verifies that approval remains
 * separate from dispatch.
 *
 * Stable controls already used by the planning wizard:
 * - input-draft-name, input-draft-customer-reference, input-draft-date
 * - button-draft-continue, button-draft-start-import
 * - planning-draft-flow, planning-draft-save-review
 * - The traffic planner exposes planning-draft-approve and
 *   planning-draft-dispatch-<routeId> per route after validation.
 *
 * New controls should keep their translated accessible labels.  The
 * reference search locator below also accepts input-draft-search as a stable
 * hook if the list search is implemented as a labelled text input rather than
 * an ARIA searchbox.
 */

test.setTimeout(240_000);

const DEPOT = {
  latitude: 59.3293,
  longitude: 18.0686,
};

/**
 * Trusted, test-only depot data for the disposable source route.
 *
 * This is intentionally written to the development database after the route
 * is created.  It represents an already verified historical route snapshot;
 * it does not claim that an external geocoder verified these addresses.
 */
const TRUSTED_DEPOT_SNAPSHOT = {
  start: {
    address: "E2E trusted depot start, Stockholm",
    latitude: 59.3293,
    longitude: 18.0686,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: { source: "trusted-e2e-fixture", method: "test-db-seed" },
  },
  end: {
    address: "E2E trusted depot end, Stockholm",
    latitude: 59.3293,
    longitude: 18.0686,
    verifiedAt: "2026-01-01T00:00:00.000Z",
    verification: { source: "trusted-e2e-fixture", method: "test-db-seed" },
  },
} as const;

const DRIVER_DEPOT = {
  startAddress: "E2E planning-input driver depot start, Stockholm",
  startLatitude: DEPOT.latitude,
  startLongitude: DEPOT.longitude,
  endAddress: "E2E planning-input driver depot end, Stockholm",
  endLatitude: DEPOT.latitude,
  endLongitude: DEPOT.longitude,
} as const;

const execFileAsync = promisify(execFile);

type ApiResult = {
  status: number;
  body: any;
};

type DraftRecord = {
  id: string;
  revision: number;
  startAt: string;
  state: Record<string, unknown>;
  planId?: string | null;
};

type DisposableFixture = {
  vehicleIds: string[];
  driverIds: string[];
  appUserIds: string[];
  stopIds: string[];
  routeIds: string[];
  draftIds: string[];
};

const DEFAULT_PLANNING_INPUTS = {
  version: 1 as const,
  objective: "balanced" as const,
  travelReservePercent: 0,
  stopReserveMin: 0,
  stopPriorities: {} as Record<string, 0 | 1 | 2>,
  excludedPairValues: [] as string[],
  depotOverride: null,
  vehicleSelectionMode: "use_all_selected_pairs" as const,
};

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

function assertStatus(result: ApiResult, status: number): any {
  expect(result.status, JSON.stringify(result.body)).toBe(status);
  return result.body;
}

async function createVehicleDriver(
  page: Page,
  organizationId: string,
  suffix: string,
  fixture: DisposableFixture,
  options: {
    capacityKg?: number;
    capacityVolume?: number;
    driverCapacityKg?: number;
    driverCapacityVolume?: number;
  } = {},
): Promise<{ vehicleId: string; driverId: string }> {
  const vehicle = assertStatus(
    await api(page, "/api/vehicles", "POST", {
      organizationId,
      name: `E2E planning-input vehicle ${suffix}`,
      licensePlate: `PI-${suffix}`,
      vehicleType: "fossil",
      capacityKg: options.capacityKg ?? 1_000,
      capacityVolume: options.capacityVolume ?? 50,
      isActive: true,
      driver: {
        name: `E2E planning-input driver ${suffix}`,
        capacityKg: options.driverCapacityKg ?? options.capacityKg ?? 1_000,
        capacityVolume: options.driverCapacityVolume ?? options.capacityVolume ?? 50,
      },
    }),
    201,
  );
  fixture.vehicleIds.push(vehicle.id);

  const driver = vehicle.resourceProfile;
  expect(driver?.id).toBeTruthy();
  expect(driver.vehicleId).toBe(vehicle.id);
  fixture.driverIds.push(driver.id);

  return { vehicleId: vehicle.id, driverId: driver.id };
}

async function createStop(
  page: Page,
  organizationId: string,
  suffix: string,
  index: number,
  options: { weightKg?: number; volumeM3?: number; priority?: number } = {},
): Promise<string> {
  const stop = assertStatus(
    await api(page, "/api/stops", "POST", {
      organizationId,
      address: `E2E planning-input stop ${suffix}-${index}`,
      customerName: `E2E planning customer ${suffix}-${index}`,
      latitude: DEPOT.latitude + index * 0.001,
      longitude: DEPOT.longitude + index * 0.001,
      jobType: "delivery",
      weightKg: options.weightKg ?? 1,
      volumeM3: options.volumeM3 ?? 0.1,
      serviceDurationMin: 5,
      priority: options.priority,
      status: "pending",
    }),
    201,
  );
  return stop.id;
}

async function createDraft(
  page: Page,
  name: string,
  startAt: string,
  state: Record<string, unknown>,
  fixture: DisposableFixture,
): Promise<DraftRecord> {
  const draft = assertStatus(
    await api(page, "/api/planning-drafts", "POST", {
      name,
      startAt,
      state,
    }),
    201,
  ) as DraftRecord;
  fixture.draftIds.push(draft.id);
  return draft;
}

async function draft(page: Page, draftId: string): Promise<DraftRecord> {
  return assertStatus(
    await api(page, `/api/planning-drafts/${draftId}`),
    200,
  ) as DraftRecord;
}

async function updateDraftState(
  page: Page,
  current: DraftRecord,
  state: Record<string, unknown>,
): Promise<DraftRecord> {
  return assertStatus(
    await api(page, `/api/planning-drafts/${current.id}`, "PUT", {
      revision: current.revision,
      state,
    }),
    200,
  ) as DraftRecord;
}

async function route(page: Page, routeId: string): Promise<any> {
  return assertStatus(await api(page, `/api/routes/${routeId}`), 200);
}

async function seedTrustedDepotSnapshot(
  organizationId: string,
  routeId: string,
): Promise<typeof TRUSTED_DEPOT_SNAPSHOT> {
  await execFileAsync(
    "pnpm",
    [
      "--filter",
      "@workspace/scripts",
      "exec",
      "tsx",
      "--eval",
      `
import { pool } from "@workspace/db";

void (async () => {
  const organizationId = process.env.E2E_DEPOT_ORGANIZATION_ID;
  const routeId = process.env.E2E_DEPOT_ROUTE_ID;
  const snapshot = process.env.E2E_DEPOT_SNAPSHOT;
  if (!organizationId || !routeId || !snapshot) {
    throw new Error("Trusted depot fixture arguments are missing");
  }

  try {
    const result = await pool.query(
      \`UPDATE routes
     SET depot_snapshot = $1::jsonb
     WHERE id = $2::uuid
       AND organization_id = $3::uuid
     RETURNING id\`,
      [snapshot, routeId, organizationId],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        "Trusted depot fixture update matched " +
          (result.rowCount ?? 0) +
          " routes",
      );
    }
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
      `,
    ],
    {
      env: {
        ...process.env,
        E2E_DEPOT_ORGANIZATION_ID: organizationId,
        E2E_DEPOT_ROUTE_ID: routeId,
        E2E_DEPOT_SNAPSHOT: JSON.stringify(TRUSTED_DEPOT_SNAPSHOT),
      },
    },
  );
  return TRUSTED_DEPOT_SNAPSHOT;
}

/**
 * The second test intentionally exercises a plan without an organization
 * depot override. Seed coordinates only on its own active driver resource so
 * route review has a real immutable fallback without touching shared org
 * settings or any customer data.
 */
async function seedDriverDepot(
  organizationId: string,
  driverId: string,
): Promise<void> {
  await execFileAsync(
    "pnpm",
    [
      "--filter",
      "@workspace/scripts",
      "exec",
      "tsx",
      "--eval",
      `
import { pool } from "@workspace/db";

void (async () => {
  const organizationId = process.env.E2E_DRIVER_DEPOT_ORGANIZATION_ID;
  const driverId = process.env.E2E_DRIVER_DEPOT_DRIVER_ID;
  const startAddress = process.env.E2E_DRIVER_DEPOT_START_ADDRESS;
  const startLatitude = process.env.E2E_DRIVER_DEPOT_START_LATITUDE;
  const startLongitude = process.env.E2E_DRIVER_DEPOT_START_LONGITUDE;
  const endAddress = process.env.E2E_DRIVER_DEPOT_END_ADDRESS;
  const endLatitude = process.env.E2E_DRIVER_DEPOT_END_LATITUDE;
  const endLongitude = process.env.E2E_DRIVER_DEPOT_END_LONGITUDE;
  if (
    !organizationId ||
    !driverId ||
    !startAddress ||
    !startLatitude ||
    !startLongitude ||
    !endAddress ||
    !endLatitude ||
    !endLongitude
  ) {
    throw new Error("Driver depot fixture arguments are missing");
  }

  try {
    const result = await pool.query(
      \`UPDATE drivers
       SET start_address = $1,
           start_latitude = $2,
           start_longitude = $3,
           end_address = $4,
           end_latitude = $5,
           end_longitude = $6
       WHERE id = $7::uuid
         AND organization_id = $8::uuid
         AND is_active = true
       RETURNING id\`,
      [
        startAddress,
        Number(startLatitude),
        Number(startLongitude),
        endAddress,
        Number(endLatitude),
        Number(endLongitude),
        driverId,
        organizationId,
      ],
    );
    if (result.rowCount !== 1) {
      throw new Error(
        "Driver depot fixture update matched " +
          (result.rowCount ?? 0) +
          " drivers",
      );
    }
  } finally {
    await pool.end();
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
      `,
    ],
    {
      env: {
        ...process.env,
        E2E_DRIVER_DEPOT_ORGANIZATION_ID: organizationId,
        E2E_DRIVER_DEPOT_DRIVER_ID: driverId,
        E2E_DRIVER_DEPOT_START_ADDRESS: DRIVER_DEPOT.startAddress,
        E2E_DRIVER_DEPOT_START_LATITUDE: String(DRIVER_DEPOT.startLatitude),
        E2E_DRIVER_DEPOT_START_LONGITUDE: String(DRIVER_DEPOT.startLongitude),
        E2E_DRIVER_DEPOT_END_ADDRESS: DRIVER_DEPOT.endAddress,
        E2E_DRIVER_DEPOT_END_LATITUDE: String(DRIVER_DEPOT.endLatitude),
        E2E_DRIVER_DEPOT_END_LONGITUDE: String(DRIVER_DEPOT.endLongitude),
      },
    },
  );
}

async function expectDriverDepot(page: Page, driverId: string): Promise<void> {
  expect(
    assertStatus(await api(page, `/api/drivers/${driverId}`), 200),
  ).toMatchObject({
    isActive: true,
    startAddress: DRIVER_DEPOT.startAddress,
    startLatitude: DRIVER_DEPOT.startLatitude,
    startLongitude: DRIVER_DEPOT.startLongitude,
    endAddress: DRIVER_DEPOT.endAddress,
    endLatitude: DRIVER_DEPOT.endLatitude,
    endLongitude: DRIVER_DEPOT.endLongitude,
  });
}

async function cleanupFixture(
  page: Page,
  fixture: DisposableFixture,
): Promise<void> {
  // Route deletion must precede stop deletion because assignments are
  // intentionally protected while a route exists.
  for (const routeId of fixture.routeIds) {
    await api(page, `/api/routes/${routeId}`, "DELETE");
  }
  if (fixture.stopIds.length > 0) {
    await api(page, "/api/stops/bulk-delete", "POST", {
      stopIds: fixture.stopIds,
    });
  }
  for (const appUserId of fixture.appUserIds) {
    await api(page, `/api/app-users/${appUserId}`, "DELETE");
  }
  for (const driverId of fixture.driverIds) {
    await api(page, `/api/drivers/${driverId}`, "DELETE");
  }
  for (const vehicleId of fixture.vehicleIds) {
    await api(page, `/api/vehicles/${vehicleId}`, "DELETE");
  }
}

function referenceSearch(page: Page) {
  return page
    .getByTestId("input-draft-search")
    .or(page.getByRole("searchbox"))
    .or(page.getByPlaceholder(/sök|search/i))
    .first();
}

function sharedInstructionsField(page: Page) {
  return page
    .getByLabel(/gemensam.*instr|shared.*instr|chaufförsinstr/i)
    .or(page.getByTestId("planning-draft-shared-instructions"))
    .first();
}

test("planning inputs survive optimization, approval, search, and reopen", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });

  const suffix = randomUUID().slice(0, 8);
  const planningDate = "2099-06-20";
  const startAt = `${planningDate}T00:00:00.000Z`;
  const draftName = `E2E planning inputs ${suffix}`;
  const customerReference = `E2E-REF-${suffix}`;
  const sharedInstructions = `E2E instruction ${suffix}: call the recipient before arrival.`;
  const fixture: DisposableFixture = {
    vehicleIds: [],
    driverIds: [],
    appUserIds: [],
    stopIds: [],
    routeIds: [],
    draftIds: [],
  };
  const approvalRequests: Request[] = [];
  const dispatchRequests: Request[] = [];
  const recordTransitionRequest = (request: Request) => {
    if (request.method() !== "POST") return;
    if (request.url().includes("/api/import/route-plans/") && request.url().endsWith("/approve")) {
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
  try {
    await login(page, "/routes/create", "input-draft-name");
    const organizationId = await authenticatedOrganizationId(page);

    const primaryPair = await createVehicleDriver(
      page,
      organizationId,
      `${suffix}-primary`,
      fixture,
    );
    // Keep this pair in the authoritative selected set, but make it unable
    // to serve a customer stop.  That gives the post-replan summary a real
    // unused-resource outcome instead of merely checking that a checkbox
    // changed.
    const secondaryPair = await createVehicleDriver(
      page,
      organizationId,
      `${suffix}-secondary`,
      fixture,
      {
        capacityKg: 0,
        capacityVolume: 0,
        driverCapacityKg: 0,
        driverCapacityVolume: 0,
      },
    );
    const depotPair = await createVehicleDriver(
      page,
      organizationId,
      `${suffix}-depot-source`,
      fixture,
    );
    const stopIds = await Promise.all(
      [1].map((index) => createStop(page, organizationId, suffix, index)),
    );
    fixture.stopIds.push(...stopIds);

    // Seed a separate, disposable optimized route first, then install a
    // trusted test-only depot snapshot in the development DB.  This snapshot
    // is the historical source shown by both depot selectors; it is not a
    // claim of external verification and does not modify organization settings.
    const depotSeedStopId = await createStop(
      page,
      organizationId,
      `${suffix}-depot-source`,
      4,
    );
    fixture.stopIds.push(depotSeedStopId);
    const depotSeedPlan = assertStatus(
      await api(page, "/api/import/route-plans", "POST", {
        stopIds: [depotSeedStopId],
        pairs: [depotPair],
        date: startAt,
        depotLatitude: DEPOT.latitude,
        depotLongitude: DEPOT.longitude,
        planningInputs: DEFAULT_PLANNING_INPUTS,
      }),
      200,
    );
    expect(depotSeedPlan.routes).toHaveLength(1);
    const depotSourceRouteId = depotSeedPlan.routes[0].routeId as string;
    fixture.routeIds.push(depotSourceRouteId);
    const seededDepotSnapshot = await seedTrustedDepotSnapshot(
      organizationId,
      depotSourceRouteId,
    );
    const depotSourceRoute = await route(page, depotSourceRouteId);
    expect(depotSourceRoute.organizationId).toBe(organizationId);
    expect(depotSourceRoute.depotSnapshot).toEqual(seededDepotSnapshot);

    // Use the real first page so the new reference is entered through the
    // translated control, not merely inserted into a server fixture.
    await page.getByTestId("input-draft-name").fill(draftName);
    await page
      .getByTestId("input-draft-customer-reference")
      .fill(customerReference);
    await page.getByTestId("input-draft-date").fill(planningDate);
    await page.getByTestId("button-draft-continue").click();
    await page.getByTestId("button-draft-start-import").click();
    await expect(page).toHaveURL(/\/routes\/drafts\/[0-9a-f-]{36}$/i);

    const draftId = page
      .url()
      .match(/\/routes\/drafts\/([0-9a-f-]{36})$/i)?.[1];
    expect(draftId).toBeTruthy();
    const createdDraft = await draft(page, draftId!);
    expect(createdDraft.state).toMatchObject({
      planningMetadata: { customerReference },
    });

    const planningInputs = {
      ...DEFAULT_PLANNING_INPUTS,
      travelReservePercent: 15,
      stopReserveMin: 3,
      stopPriorities: {
        [stopIds[0]]: 2 as const,
      },
    };

    // The API fixture supplies already-created nearby stops.  Move the draft
    // to the real resource/review step without re-importing or geocoding.
    const draftForPlanning = await updateDraftState(page, createdDraft, {
      ...createdDraft.state,
      source: "manual",
      step: 5,
      selectedStopIds: stopIds,
      resourceSelection: {
        pairValues: [],
        optimizationProfile: "balanced",
      },
      planningInputs,
      planningMetadata: {
        customerReference,
        sharedInstructions,
      },
    });
    expect(draftForPlanning.state).toMatchObject({
      planningInputs,
      planningMetadata: { customerReference, sharedInstructions },
    });

    // Resume at the real resource step.  The selected pair list and the
    // daily exclusion are deliberately separate controls: both selected
    // pairs must reach the planning request while the temporary exclusion is
    // carried in planningInputs.
    await page.goto(`/routes/drafts/${draftId}`);
    await expect(page.getByTestId("planning-draft-flow")).toHaveAttribute(
      "data-draft-id",
      draftId!,
    );
    const primaryPairCheckbox = page.getByTestId(
      `planning-draft-vehicle-pair-${primaryPair.vehicleId}-${primaryPair.driverId}`,
    );
    const secondaryPairCheckbox = page.getByTestId(
      `planning-draft-vehicle-pair-${secondaryPair.vehicleId}-${secondaryPair.driverId}`,
    );
    const secondaryExclusionCheckbox = page.getByTestId(
      `planning-draft-daily-pair-exclusion-${secondaryPair.vehicleId}-${secondaryPair.driverId}`,
    );
    const depotPairExclusionCheckbox = page.getByTestId(
      `planning-draft-daily-pair-exclusion-${depotPair.vehicleId}-${depotPair.driverId}`,
    );
    const depotPairCheckbox = page.getByTestId(
      `planning-draft-vehicle-pair-${depotPair.vehicleId}-${depotPair.driverId}`,
    );
    await expect(primaryPairCheckbox).toBeVisible();
    await primaryPairCheckbox.click();
    await secondaryPairCheckbox.click();
    await expect(depotPairCheckbox).not.toBeChecked();
    await page
      .getByText(/daily resource exclusions|dagliga resursundantag/i)
      .click();
    await expect(secondaryExclusionCheckbox).toBeVisible();
    await secondaryExclusionCheckbox.click();
    await expect(primaryPairCheckbox).toBeChecked();
    await expect(secondaryPairCheckbox).toBeChecked();
    await expect(secondaryExclusionCheckbox).toBeChecked();
    await expect(depotPairExclusionCheckbox).not.toBeChecked();
    await expect(
      page.locator(
        '[data-testid^="planning-draft-vehicle-pair-"][aria-checked="true"]',
      ),
    ).toHaveCount(2);

    // Select the disposable verified depot snapshot seeded above and prove
    // its option is present before optimization.
    const depotScope = page
      .getByRole("combobox")
      .filter({ hasText: /No override|Inget undantag/i })
      .first();
    await depotScope.click();
    await page
      .getByRole("option", { name: /For the entire plan|För hela planen/i })
      .click();
    const verifiedDepotSelector = page
      .getByRole("combobox")
      .filter({
        hasText: /Organization default depot|Organisationens standarddepå/i,
      })
      .first();
    await verifiedDepotSelector.click();
    const depotSourceOption = page.getByRole("option", {
      name: new RegExp(`planning-input vehicle ${suffix}-depot-source`, "i"),
    });
    await expect(depotSourceOption).toBeVisible();
    await depotSourceOption.click();

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
    expect(plan.routes.length).toBeGreaterThanOrEqual(1);
    expect(
      plan.routes.find(
        (item: { driverId: string }) => item.driverId === primaryPair.driverId,
      )?.stopCount,
    ).toBe(1);
    expect(plan.unassignedStopIds).toEqual([]);
    expect(planRequests).toHaveLength(1);
    expect(planRequests[0].draftId).toBe(draftId);
    expect(planRequests[0].stopIds).toHaveLength(1);
    expect(planRequests[0].stopIds).toEqual(expect.arrayContaining(stopIds));
    expect(planRequests[0].pairs).toEqual([
      { vehicleId: primaryPair.vehicleId, driverId: primaryPair.driverId },
      { vehicleId: secondaryPair.vehicleId, driverId: secondaryPair.driverId },
    ]);
    expect(planRequests[0].planningInputs).toMatchObject({
      excludedPairValues: [
        `${secondaryPair.vehicleId}:${secondaryPair.driverId}`,
      ],
      depotOverride: {
        scope: "plan",
        verifiedDepotId: `route:${depotSourceRouteId}`,
      },
    });
    expect(new Date(String(planRequests[0].date)).getTime()).toBe(
      new Date(createdDraft.startAt).getTime(),
    );
    expect(planRequests[0].depotLatitude).toBe(DEPOT.latitude);
    expect(planRequests[0].depotLongitude).toBe(DEPOT.longitude);
    fixture.routeIds.push(
      ...plan.routes.map((item: { routeId: string }) => item.routeId),
    );
    const primaryRouteId = plan.routes.find(
      (item: { driverId: string }) => item.driverId === primaryPair.driverId,
    )?.routeId as string | undefined;
    expect(primaryRouteId).toBeTruthy();

    // The server-side planning snapshot is the acceptance source of truth for
    // exact-once reserve accounting and mandatory priority semantics.
    expect(plan.planningSummary).toMatchObject({
      complete: true,
      objective: "balanced",
      travelReservePercent: 15,
      stopReserveMin: 3,
      mandatoryUnplannedStopIds: [],
    });
    expect(plan.planningSummary.selectedPairValues).toEqual(
      expect.arrayContaining([
        `${primaryPair.vehicleId}:${primaryPair.driverId}`,
        `${secondaryPair.vehicleId}:${secondaryPair.driverId}`,
      ]),
    );
    expect(plan.planningSummary.selectedPairValues).not.toContain(
      `${depotPair.vehicleId}:${depotPair.driverId}`,
    );
    expect(plan.planningSummary.unusedPairValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pairValue: `${secondaryPair.vehicleId}:${secondaryPair.driverId}`,
        }),
      ]),
    );
    const plannedRoute = await route(page, primaryRouteId!);
    expect(plannedRoute).toMatchObject({
      customerReference,
      sharedInstructions,
      optimizationPlanningSnapshot: expect.objectContaining({
        ...planningInputs,
        excludedPairValues: [
          `${secondaryPair.vehicleId}:${secondaryPair.driverId}`,
        ],
        depotOverride: {
          scope: "plan",
          verifiedDepotId: `route:${depotSourceRouteId}`,
        },
      }),
      planningSummary: {
        complete: true,
        travelReservePercent: 15,
        stopReserveMin: 3,
      },
    });
    expect(plannedRoute.depotSnapshot).toMatchObject({
      start: { verifiedAt: expect.anything() },
      end: { verifiedAt: expect.anything() },
    });
    expect(plannedRoute.workdayTimeline).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "travel_reserve" }),
        expect.objectContaining({ type: "stop_reserve", durationMin: 3 }),
      ]),
    );
    expect(plannedRoute.workdaySummary).toMatchObject({
      travelReserveMin: expect.any(Number),
      stopReserveMin: 3,
    });

    // Step 7 must be authoritative: it offers the two pairs committed by
    // the plan, not the unrelated organization pair used only as the depot
    // snapshot source.  The daily exclusion is shown separately so it can be
    // removed and re-optimized without expanding the material-resource set.
    await expect(
      page.getByTestId(
        `checkbox-replan-resource-${primaryPair.vehicleId}-${primaryPair.driverId}`,
      ),
    ).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByTestId(
        `checkbox-replan-resource-${secondaryPair.vehicleId}-${secondaryPair.driverId}`,
      ),
    ).toBeVisible();
    await expect(
      page.getByTestId(
        `checkbox-replan-resource-${depotPair.vehicleId}-${depotPair.driverId}`,
      ),
    ).not.toBeChecked();
    const step7PrimaryPair = page.getByTestId(
      `planning-input-pair-${primaryPair.vehicleId}-${primaryPair.driverId}`,
    );
    const step7SecondaryPair = page.getByTestId(
      `planning-input-pair-${secondaryPair.vehicleId}-${secondaryPair.driverId}`,
    );
    const step7DepotPair = page.getByTestId(
      `planning-input-pair-${depotPair.vehicleId}-${depotPair.driverId}`,
    );
    await expect(step7PrimaryPair).toBeChecked();
    await expect(step7SecondaryPair).toBeVisible();
    await expect(step7SecondaryPair).not.toBeChecked();
    await expect(step7DepotPair).toHaveCount(0);
    await expect(page.getByTestId("planning-input-travel-reserve")).toHaveValue(
      "15",
    );
    await expect(page.getByTestId("planning-input-stop-reserve")).toHaveValue(
      "3",
    );

    const step7DepotSourceOption = page.getByRole("option", {
      name: new RegExp(`planning-input vehicle ${suffix}-depot-source`, "i"),
    });
    const step7VerifiedDepotSelector = page
      .getByRole("combobox")
      .filter({
        hasText: new RegExp(
          `planning-input vehicle ${suffix}-depot-source`,
          "i",
        ),
      })
      .first();
    await step7VerifiedDepotSelector.click();
    await expect(step7DepotSourceOption).toBeVisible();
    await page.keyboard.press("Escape");

    // Removing the daily exclusion is a real planning-input reoptimization,
    // not a local checkbox assertion.  The payload must retain both the
    // original pair commitment and the exact reserve values.
    await expect(step7SecondaryPair).not.toBeChecked();
    await step7SecondaryPair.click();
    await expect(step7PrimaryPair).toBeChecked();
    await expect(step7SecondaryPair).toBeChecked();
    page.once("dialog", dialog => dialog.accept());
    const reoptimizationResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .includes(
            `/api/import/route-plans/${plan.planId}/reoptimize-planning-inputs`,
          ),
    );
    const reoptimizationRequestPromise = page.waitForRequest(
      (request) =>
        request.method() === "POST" &&
        request
          .url()
          .includes(
            `/api/import/route-plans/${plan.planId}/reoptimize-planning-inputs`,
          ),
    );
    await page.getByTestId("planning-input-replan").click();
    const reoptimizationRequest = await reoptimizationRequestPromise;
    const reoptimizationResponse = await reoptimizationResponsePromise;
    expect(reoptimizationResponse.status()).toBe(200);
    const reoptimizationResult = await reoptimizationResponse.json();
    fixture.routeIds.push(
      ...reoptimizationResult.routes
        .map((item: { routeId: string }) => item.routeId)
        .filter((routeId: string) => !fixture.routeIds.includes(routeId)),
    );
    const reoptimizationBody = reoptimizationRequest.postDataJSON() as {
      planningInputs?: Record<string, unknown>;
    };
    expect(reoptimizationBody.planningInputs).toMatchObject({
      travelReservePercent: 15,
      stopReserveMin: 3,
      excludedPairValues: [],
      depotOverride: {
        scope: "plan",
        verifiedDepotId: `route:${depotSourceRouteId}`,
      },
    });
    const summaryAfterReoptimization = assertStatus(
      await api(
        page,
        `/api/import/route-plans/${plan.planId}/planning-summary`,
      ),
      200,
    );
    expect(summaryAfterReoptimization.planningInputs).toMatchObject({
      travelReservePercent: 15,
      stopReserveMin: 3,
      excludedPairValues: [],
      depotOverride: {
        scope: "plan",
        verifiedDepotId: `route:${depotSourceRouteId}`,
      },
    });
    expect(
      summaryAfterReoptimization.planningSummary.selectedPairValues,
    ).toEqual(
      expect.arrayContaining([
        `${primaryPair.vehicleId}:${primaryPair.driverId}`,
        `${secondaryPair.vehicleId}:${secondaryPair.driverId}`,
      ]),
    );
    expect(
      summaryAfterReoptimization.planningSummary.selectedPairValues,
    ).not.toContain(`${depotPair.vehicleId}:${depotPair.driverId}`);
    expect(summaryAfterReoptimization.planningSummary.unusedPairValues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pairValue: `${secondaryPair.vehicleId}:${secondaryPair.driverId}`,
        }),
      ]),
    );
    const postReoptimizationDepotSelector = page
      .getByRole("combobox")
      .filter({
        hasText: new RegExp(
          `planning-input vehicle ${suffix}-depot-source`,
          "i",
        ),
      })
      .first();
    await postReoptimizationDepotSelector.click();
    await expect(
      page.getByRole("option", {
        name: new RegExp(`planning-input vehicle ${suffix}-depot-source`, "i"),
      }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    expect((await route(page, depotSourceRouteId)).depotSnapshot).toEqual(
      seededDepotSnapshot,
    );
    await expect(
      page.getByTestId(
        `checkbox-replan-resource-${depotPair.vehicleId}-${depotPair.driverId}`,
      ),
    ).not.toBeChecked();
    await expect(page.getByTestId("planning-input-travel-reserve")).toHaveValue(
      "15",
    );
    await expect(page.getByTestId("planning-input-stop-reserve")).toHaveValue(
      "3",
    );

    // Resume through the actual browser review/approval controls.  Approval
    // is separate from dispatch; no notification is generated at this point.
    await page.goto(`/routes/drafts/${draftId}`);
    await expect(page.getByTestId("planning-draft-flow")).toHaveAttribute(
      "data-draft-id",
      draftId!,
    );
    await expect(
      page
        .getByTestId("planning-draft-flow")
        .getByText(customerReference, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(sharedInstructions, { exact: false }),
    ).toBeVisible();
    await expect(page.getByText(/15\s*%|15\s*procent/i)).toBeVisible();
    await expect(page.getByText(/3\s*(min|minutes|minuter)/i)).toBeVisible();
    await expect(
      page
        .getByTestId("planning-draft-flow")
        .getByText(/måste(?:\s+med)?|mandatory/i)
        .first(),
    ).toBeVisible();

    await expect(page.getByTestId("planning-draft-save-review")).toBeVisible();
    // Already saved: opening review must not replay a plan mutation.
    await page.getByTestId("planning-draft-save-review").click();
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
      page.getByTestId(`planning-draft-dispatch-${primaryRouteId}`),
    ).toHaveCount(0);
    await expect(page.getByTestId("planning-draft-approve")).toBeVisible();
    expect(approvalRequests).toHaveLength(0);
    expect(dispatchRequests).toHaveLength(0);
    expect((await draft(page, draftId!)).state.step).toBe(6);

    const approvalResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/import/route-plans/${plan.planId}/approve`),
    );
    await expect(page.getByTestId("planning-draft-approve")).toBeVisible();
    await page.getByTestId("planning-draft-approve").click();
    expect((await approvalResponsePromise).status()).toBe(200);
    expect(approvalRequests).toHaveLength(1);
    expect(dispatchRequests).toHaveLength(0);
    await expect(
      page.getByTestId(`planning-draft-dispatch-${primaryRouteId}`),
    ).toBeVisible();

    const approvedRoute = await route(page, primaryRouteId!);
    expect(approvedRoute.handoffStatus).toBe("pending");
    expect(approvedRoute.sentAt).toBeNull();

    // Approval is deliberately not a dispatch.  The route remains eligible
    // for the separate explicit handoff action and no external webhook has
    // been emitted by this spec.
    expect(dispatchRequests).toHaveLength(0);
    expect((await route(page, primaryRouteId!)).handoffStatus).toBe("pending");

    // The reference is searchable from the persisted draft list and remains
    // visible after reopening the exact same draft.
    await page.goto("/routes/create");
    const search = referenceSearch(page);
    await expect(search).toBeVisible();
    await search.fill(customerReference);
    await expect(
      page.getByTestId(`button-draft-resume-${draftId}`),
    ).toBeVisible();
    await page.getByTestId(`button-draft-resume-${draftId}`).click();
    await expect(page).toHaveURL(new RegExp(`/routes/drafts/${draftId}$`));
    await expect(
      page
        .getByTestId("planning-draft-flow")
        .getByText(customerReference, { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByText(sharedInstructions, { exact: false }),
    ).toBeVisible();
    await expect(
      page.getByTestId(`planning-draft-dispatch-${primaryRouteId}`),
    ).toBeVisible();

  } finally {
    page.off("request", recordTransitionRequest);
    await cleanupFixture(page, fixture);
  }
});

test("clearing a post-plan instruction requires fresh approval and a mandatory infeasible stop cannot approve", async ({
  page,
}) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });

  const suffix = randomUUID().slice(0, 8);
  const fixture: DisposableFixture = {
    vehicleIds: [],
    driverIds: [],
    appUserIds: [],
    stopIds: [],
    routeIds: [],
    draftIds: [],
  };
  const approvalRequests: Request[] = [];
  const dispatchRequests: Request[] = [];
  const recordTransitionRequest = (request: Request) => {
    if (request.method() !== "POST") return;
    if (request.url().includes("/api/import/route-plans/") && request.url().endsWith("/approve")) {
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

  try {
    await login(page, "/routes/create", "input-draft-name");
    const organizationId = await authenticatedOrganizationId(page);

    const feasiblePair = await createVehicleDriver(
      page,
      organizationId,
      `${suffix}-feasible`,
      fixture,
    );
    await seedDriverDepot(organizationId, feasiblePair.driverId);
    await expectDriverDepot(page, feasiblePair.driverId);
    const feasibleStopId = await createStop(
      page,
      organizationId,
      `${suffix}-feasible`,
      1,
    );
    fixture.stopIds.push(feasibleStopId);
    const feasibleDraft = await createDraft(
      page,
      `E2E instruction revision ${suffix}`,
      "2099-06-21T00:00:00.000Z",
      {
        source: "manual",
        step: 6,
        selectedStopIds: [feasibleStopId],
        planningInputs: DEFAULT_PLANNING_INPUTS,
        planningMetadata: { customerReference: `E2E-REV-${suffix}` },
      },
      fixture,
    );
    const initialInstruction = `E2E initial instruction ${suffix}`;
    const feasiblePlan = assertStatus(
      await api(page, "/api/import/route-plans", "POST", {
        draftId: feasibleDraft.id,
        stopIds: [feasibleStopId],
        pairs: [feasiblePair],
        date: feasibleDraft.startAt,
        depotLatitude: DEPOT.latitude,
        depotLongitude: DEPOT.longitude,
        planningInputs: DEFAULT_PLANNING_INPUTS,
        customerReference: `E2E-REV-${suffix}`,
        sharedInstructions: initialInstruction,
      }),
      200,
    );
    fixture.routeIds.push(
      ...feasiblePlan.routes.map((item: { routeId: string }) => item.routeId),
    );
    expect(feasiblePlan.routes).toHaveLength(1);

    const initialApproval = assertStatus(
      await api(
        page,
        `/api/import/route-plans/${feasiblePlan.planId}/approval`,
      ),
      200,
    );
    const initialApprovalResponse = assertStatus(
      await api(
        page,
        `/api/import/route-plans/${feasiblePlan.planId}/approve`,
        "POST",
        {
          routes: initialApproval.routes.map((item: any) => ({
            routeId: item.routeId,
            planRevision: item.planRevision,
            driverId: item.driverId,
          })),
        },
      ),
      200,
    );
    expect(initialApprovalResponse.routes[0].approval.approved).toBe(true);

    const beforeRevision = (await route(page, fixture.routeIds[0]))
      .planRevision;
    const currentDraft = await draft(page, feasibleDraft.id);
    const clearedInstruction = assertStatus(
      await api(
        page,
        `/api/import/route-plans/${feasiblePlan.planId}/reoptimize-planning-inputs`,
        "POST",
        {
          draftId: feasibleDraft.id,
          draftRevision: currentDraft.revision,
          planningInputs: DEFAULT_PLANNING_INPUTS,
          sharedInstructions: null,
        },
      ),
      200,
    );
    expect(clearedInstruction.planId).toBe(feasiblePlan.planId);

    const afterClearRoute = await route(page, fixture.routeIds[0]);
    expect(afterClearRoute.sharedInstructions).toBeNull();
    expect(afterClearRoute.planRevision).toBeGreaterThan(beforeRevision);
    const approvalAfterClear = assertStatus(
      await api(
        page,
        `/api/import/route-plans/${feasiblePlan.planId}/approval`,
      ),
      200,
    );
    expect(approvalAfterClear.routes[0].approval.approved).toBe(false);

    // Reopen the review UI after the material instruction edit.  The old
    // instruction must be gone, and the new approval is an actual UI action.
    await page.goto(`/routes/drafts/${feasibleDraft.id}`);
    await expect(page.getByTestId("planning-draft-flow")).toHaveAttribute(
      "data-draft-id",
      feasibleDraft.id,
    );
    await expect(
      page.getByText(initialInstruction, { exact: false }),
    ).toHaveCount(0);
    const instructionField = sharedInstructionsField(page);
    await expect(instructionField).toBeVisible();
    await expect(instructionField).toHaveValue("");
    // The instruction change was already persisted above.
    await page.getByTestId("planning-draft-save-review").click();
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
      planId: feasiblePlan.planId,
    });
    await page.getByTestId("dispatch-plan-workflow-open").click();
    await expect(page.getByTestId("dispatch-plan-workflow-dialog")).toBeVisible();
    const validationSuccess = page
      .getByRole("alert")
      .filter({ hasText: /saved|validated|sparad|validerad/i })
      .first();
    await expect(validationSuccess).toBeVisible();
    await expect(
      page.getByTestId(`planning-draft-dispatch-${fixture.routeIds[0]}`),
    ).toHaveCount(0);
    await expect(page.getByTestId("planning-draft-approve")).toBeVisible();
    expect(approvalRequests).toHaveLength(0);
    expect(dispatchRequests).toHaveLength(0);
    expect((await draft(page, feasibleDraft.id)).state.step).toBe(6);

    const freshApprovalPromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response
          .url()
          .endsWith(`/api/import/route-plans/${feasiblePlan.planId}/approve`),
    );
    await expect(page.getByTestId("planning-draft-approve")).toBeVisible();
    await page.getByTestId("planning-draft-approve").click();
    expect((await freshApprovalPromise).status()).toBe(200);
    expect(approvalRequests).toHaveLength(1);
    expect(dispatchRequests).toHaveLength(0);
    const freshApproval = assertStatus(
      await api(
        page,
        `/api/import/route-plans/${feasiblePlan.planId}/approval`,
      ),
      200,
    );
    expect(freshApproval.routes[0].approval.approved).toBe(true);

    // A nearby normal stop plus an oversized mandatory stop makes the
    // optimizer return a real partial plan and a concrete unplanned reason.
    const infeasiblePair = await createVehicleDriver(
      page,
      organizationId,
      `${suffix}-mandatory`,
      fixture,
      { capacityKg: 10, capacityVolume: 1 },
    );
    await seedDriverDepot(organizationId, infeasiblePair.driverId);
    await expectDriverDepot(page, infeasiblePair.driverId);
    const normalStopId = await createStop(
      page,
      organizationId,
      `${suffix}-mandatory-normal`,
      1,
      { weightKg: 1, volumeM3: 0.1 },
    );
    const mandatoryStopId = await createStop(
      page,
      organizationId,
      `${suffix}-mandatory-required`,
      2,
      { weightKg: 100, volumeM3: 0.1 },
    );
    fixture.stopIds.push(normalStopId, mandatoryStopId);
    const mandatoryInputs = {
      ...DEFAULT_PLANNING_INPUTS,
      stopPriorities: { [mandatoryStopId]: 2 as const },
    };
    const mandatoryDraft = await createDraft(
      page,
      `E2E mandatory infeasible ${suffix}`,
      "2099-06-22T00:00:00.000Z",
      {
        source: "manual",
        step: 6,
        selectedStopIds: [normalStopId, mandatoryStopId],
        planningInputs: mandatoryInputs,
      },
      fixture,
    );
    const mandatoryPlan = assertStatus(
      await api(page, "/api/import/route-plans", "POST", {
        draftId: mandatoryDraft.id,
        stopIds: [normalStopId, mandatoryStopId],
        pairs: [infeasiblePair],
        date: mandatoryDraft.startAt,
        depotLatitude: DEPOT.latitude,
        depotLongitude: DEPOT.longitude,
        planningInputs: mandatoryInputs,
      }),
      200,
    );
    fixture.routeIds.push(
      ...mandatoryPlan.routes.map((item: { routeId: string }) => item.routeId),
    );
    expect(mandatoryPlan.unassignedStopIds).toContain(mandatoryStopId);
    expect(mandatoryPlan.planningSummary).toMatchObject({
      complete: false,
      mandatoryUnplannedStopIds: [mandatoryStopId],
    });

    const mandatoryApprovalBefore = assertStatus(
      await api(
        page,
        `/api/import/route-plans/${mandatoryPlan.planId}/approval`,
      ),
      200,
    );
    expect(mandatoryApprovalBefore.routes.length).toBeGreaterThan(0);

    // The UI must expose the unplanned mandatory outcome rather than silently
    // dropping it.  If the control is disabled, that is the intended guard;
    // otherwise clicking it must reach the real 409 approval response.
    await page.goto(`/routes/drafts/${mandatoryDraft.id}`);
    await expect(
      page
        .getByTestId("planning-draft-flow")
        .getByText(/måste(?:\s+med)?|mandatory/i)
        .first(),
    ).toBeVisible();
    await expect(
      page.getByText(/E2E planning-input stop .*mandatory-required/i).first(),
    ).toBeVisible();
    // Review the saved infeasible plan without reapplying it.
    await page.getByTestId("planning-draft-save-review").click();
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
      planId: mandatoryPlan.planId,
    });
    await expect(
      page.getByTestId(`planning-draft-dispatch-${fixture.routeIds.at(-1)}`),
    ).toHaveCount(0);
    await page.getByTestId("dispatch-plan-workflow-open").click();
    await expect(page.getByTestId("dispatch-plan-workflow-dialog")).toBeVisible();
    const mandatoryApprove = page.getByTestId("planning-draft-approve");
    await expect(mandatoryApprove).toBeVisible();
    const approvalRequestCountBeforeMandatory = approvalRequests.length;
    if (await mandatoryApprove.isDisabled()) {
      await expect(mandatoryApprove).toBeDisabled();
      expect(approvalRequests).toHaveLength(approvalRequestCountBeforeMandatory);
    } else {
      const blockedApprovalPromise = page.waitForResponse(
        (response) =>
          response.request().method() === "POST" &&
          response
            .url()
            .endsWith(
              `/api/import/route-plans/${mandatoryPlan.planId}/approve`,
            ),
      );
      await mandatoryApprove.click();
      const blockedApproval = await blockedApprovalPromise;
      expect(blockedApproval.status()).toBe(409);
      expect(approvalRequests).toHaveLength(approvalRequestCountBeforeMandatory + 1);
      await expect(
        page.getByText(/måste(?:\s+med)?|mandatory|complete|godkän/i).first(),
      ).toBeVisible();
    }
    expect(dispatchRequests).toHaveLength(0);

    const mandatoryApprovalAfter = assertStatus(
      await api(
        page,
        `/api/import/route-plans/${mandatoryPlan.planId}/approval`,
      ),
      200,
    );
    expect(
      mandatoryApprovalAfter.routes.some((item: any) => item.approval.approved),
    ).toBe(false);
  } finally {
    page.off("request", recordTransitionRequest);
    await cleanupFixture(page, fixture);
  }
});
