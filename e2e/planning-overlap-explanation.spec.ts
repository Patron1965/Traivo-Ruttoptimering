import { expect, test, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";

test.setTimeout(180_000);
const execFileAsync = promisify(execFile);

const DEPOT_SNAPSHOT = {
  start: {
    address: "E2E immutable depot start, Stockholm",
    latitude: 59.3293,
    longitude: 18.0686,
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
    latitude: 59.3293,
    longitude: 18.0686,
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

async function provisionDisposableAuthFixture(
  suffix: string,
): Promise<DisposableAuthFixture> {
  const fixture = {
    organizationId: randomUUID(),
    userId: randomUUID(),
    email: `e2e-overlap-${suffix}@example.test`,
    password: `Overlap-${randomUUID()}-Aa1!`,
  };
  const script = `
    import { randomBytes, scrypt } from "node:crypto";
    import { promisify } from "node:util";
    import { db, organizationsTable, pool, usersTable } from "@workspace/db";
    const scryptAsync = promisify(scrypt);
    const organizationId = process.env.E2E_FIXTURE_ORGANIZATION_ID;
    const userId = process.env.E2E_FIXTURE_USER_ID;
    const email = process.env.E2E_FIXTURE_EMAIL;
    const password = process.env.E2E_FIXTURE_PASSWORD;
    if (!organizationId || !userId || !email || !password) {
      throw new Error("Disposable fixture arguments are missing");
    }
    void (async () => {
      const salt = randomBytes(16).toString("hex");
      const derived = (await scryptAsync(password, salt, 64)) as Buffer;
      await db.insert(organizationsTable).values({
        id: organizationId,
        name: "E2E overlap disposable organization",
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
        name: "E2E overlap disposable admin",
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
        E2E_FIXTURE_ORGANIZATION_ID: fixture.organizationId,
        E2E_FIXTURE_USER_ID: fixture.userId,
        E2E_FIXTURE_EMAIL: fixture.email,
        E2E_FIXTURE_PASSWORD: fixture.password,
      },
    },
  );
  return fixture;
}

async function cleanupDisposableAuthFixture(
  fixture: DisposableAuthFixture,
): Promise<void> {
  const script = `
    import {
      auditLogTable,
      db,
      driversTable,
      organizationsTable,
      planningDraftsTable,
      pool,
      routesTable,
      sessionsTable,
      stopsTable,
      usersTable,
      vehiclesTable,
    } from "@workspace/db";
    import { eq } from "drizzle-orm";
    const organizationId = process.env.E2E_FIXTURE_ORGANIZATION_ID;
    if (!organizationId) throw new Error("Disposable organization id is missing");
    void (async () => {
      await db.delete(auditLogTable).where(eq(auditLogTable.organizationId, organizationId));
      await db.delete(sessionsTable).where(eq(sessionsTable.organizationId, organizationId));
      await db.delete(planningDraftsTable).where(eq(planningDraftsTable.organizationId, organizationId));
      // API vehicle deletion archives rows (is_active=false), so cleanup must
      // remove this disposable tenant's rows directly before deleting its org.
      // Stop -> route -> driver -> vehicle follows the FK dependency order.
      await db.delete(stopsTable).where(eq(stopsTable.organizationId, organizationId));
      await db.delete(routesTable).where(eq(routesTable.organizationId, organizationId));
      await db.delete(driversTable).where(eq(driversTable.organizationId, organizationId));
      await db.delete(vehiclesTable).where(eq(vehiclesTable.organizationId, organizationId));
      await db.delete(usersTable).where(eq(usersTable.organizationId, organizationId));
      await db.delete(organizationsTable).where(eq(organizationsTable.id, organizationId));
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
        E2E_FIXTURE_ORGANIZATION_ID: fixture.organizationId,
      },
    },
  );
}

async function loginAsDisposableUser(
  page: Page,
  fixture: DisposableAuthFixture,
): Promise<void> {
  // This deliberately goes through the real sign-in form. The fixture only
  // creates the tenant credentials; it does not seed a session or stub auth.
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

test("renders, reopens, and invalidates bounded overlap evidence", async ({
  page,
}) => {
  const suffix = randomUUID().slice(0, 8);
  const authFixture = await provisionDisposableAuthFixture(suffix);
  const vehicleIds: string[] = [];
  const driverIds: string[] = [];
  const stopIds: string[] = [];
  const routeIds: string[] = [];

  try {
    await loginAsDisposableUser(page, authFixture);
    const organizationId = authFixture.organizationId;

    for (let index = 0; index < 2; index += 1) {
      const vehicle = await api(page, "/api/vehicles", "POST", {
        organizationId,
        name: `E2E overlap vehicle ${suffix}-${index + 1}`,
        licensePlate: `OVL-${suffix}-${index + 1}`,
        vehicleType: "fossil",
        capacityKg: 20,
        capacityVolume: 10,
        isActive: true,
        driver: { name: `E2E overlap driver ${suffix}-${index + 1}` },
      });
      expect(vehicle.status).toBe(201);
      vehicleIds.push(vehicle.body.id);

      const driver = vehicle.body.resourceProfile;
      expect(driver?.id).toBeTruthy();
      expect(driver.vehicleId).toBe(vehicle.body.id);
      driverIds.push(driver.id);
    }

    for (let index = 0; index < 4; index += 1) {
      const stop = await api(page, "/api/stops", "POST", {
        organizationId,
        address: `E2E overlap stop ${suffix}-${index + 1}`,
        latitude: 59.3293 + index * 0.001,
        longitude: 18.0686 + index * 0.001,
        jobType: "delivery",
        weightKg: 10,
        volumeM3: 0.1,
        serviceDurationMin: 5,
      });
      expect(stop.status).toBe(201);
      stopIds.push(stop.body.id);
    }

    const draft = await api(page, "/api/planning-drafts", "POST", {
      name: `E2E overlap draft ${suffix}`,
      startAt: "2099-06-17T00:00:00.000Z",
      state: { step: 6 },
    });
    expect(draft.status).toBe(201);

    const plan = await api(page, "/api/import/route-plans", "POST", {
      draftId: draft.body.id,
      stopIds,
      pairs: vehicleIds.map((vehicleId, index) => ({
        vehicleId,
        driverId: driverIds[index],
      })),
      date: "2099-06-17T00:00:00.000Z",
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
    });
    expect(plan.status).toBe(200);
    expect(plan.body.routes).toHaveLength(2);
    routeIds.push(
      ...plan.body.routes.map((route: { routeId: string }) => route.routeId),
    );

    await page.goto(`/routes/drafts/${draft.body.id}`);
    await expect(page.getByTestId("planning-draft-route")).toHaveCount(2);

    const explanations = page.locator(
      '[data-testid^="geographic-overlap-explanation-"]',
    );
    await expect(explanations).toHaveCount(2);
    const firstExplanation = explanations.first();
    const firstRouteId = await firstExplanation.getAttribute("data-testid");
    expect(firstRouteId).toMatch(/^geographic-overlap-explanation-/);
    const routeId = firstRouteId!.replace(
      "geographic-overlap-explanation-",
      "",
    );
    const trigger = page.getByTestId(
      `button-geographic-overlap-explanation-${routeId}`,
    );

    await trigger.click();
    await expect(firstExplanation).toHaveAttribute("open", "");
    const reason = page.getByTestId(
      `text-geographic-overlap-reason-${routeId}`,
    );
    await expect(reason).toBeVisible();
    await expect(reason).toContainText(/insättning|insertion/i);
    await expect(reason).not.toContainText(/hela området|whole area/i);
    await expect(
      page.getByTestId(`text-geographic-overlap-pair-count-${routeId}`),
    ).toBeVisible();

    // Closing and reopening exercises the native details interaction rather
    // than only asserting that server text was present in the DOM.
    await trigger.click();
    await expect(firstExplanation).not.toHaveAttribute("open", "");
    await page.reload();
    await expect(page.getByTestId("planning-draft-route")).toHaveCount(2);
    await expect(explanations).toHaveCount(2);
    const reopenedAfterReload = page.getByTestId(
      `button-geographic-overlap-explanation-${routeId}`,
    );
    await expect(
      page.getByTestId(`geographic-overlap-explanation-${routeId}`),
    ).not.toHaveAttribute("open", "");
    await reopenedAfterReload.click();
    await expect(
      page.getByTestId(`text-geographic-overlap-reason-${routeId}`),
    ).toBeVisible();

    // A local reorder invalidates route-scoped evidence immediately.  The
    // stale marker is the only honest state until the protected save/refetch
    // establishes a new route revision.
    const firstRouteCard = page.getByTestId("planning-draft-route").filter({
      has: page.getByTestId(`button-geographic-overlap-explanation-${routeId}`),
    });
    await firstRouteCard
      .getByRole("button", { name: /(?:Move|Flytta).*?(?:down|nedåt)/i })
      .first()
      .click();
    await expect(explanations).toHaveCount(0);
    await expect(
      page.getByTestId("status-optimization-evidence-stale"),
    ).toBeVisible();
  } finally {
    for (const routeId of routeIds) {
      await api(page, `/api/routes/${routeId}`, "DELETE");
    }
    if (stopIds.length > 0) {
      await api(page, "/api/stops/bulk-delete", "POST", { stopIds });
    }
    for (const driverId of driverIds) {
      await api(page, `/api/drivers/${driverId}`, "DELETE");
    }
    for (const vehicleId of vehicleIds) {
      await api(page, `/api/vehicles/${vehicleId}`, "DELETE");
    }
    await cleanupDisposableAuthFixture(authFixture);
  }
});
