import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { authenticatedOrganizationId, login, test } from "./auth";

test.setTimeout(75_000);

async function api(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, {
      method,
      credentials: "include",
      ...(body === undefined ? {} : {
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
    });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { path, method, body });
}

test("a late stop is created in the selected plan, stays unassigned and survives reload", async ({ page }) => {
  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);
  const suffix = randomUUID().slice(0, 8);
  let vehicleId: string | undefined;
  let routeId: string | undefined;
  let stopId: string | undefined;
  try {
    const vehicle = await api(page, "/api/vehicles", "POST", {
      organizationId,
      name: `E2E late-stop vehicle ${suffix}`,
      licensePlate: `LST-${suffix}`,
      vehicleType: "fossil",
      capacityKg: 1_000,
      capacityVolume: 10,
      isActive: true,
    });
    expect(vehicle.status).toBe(201);
    vehicleId = vehicle.body.id;
    const route = await api(page, "/api/routes", "POST", {
      organizationId,
      vehicleId,
      name: `E2E late-stop route ${suffix}`,
      date: new Date().toISOString(),
    });
    expect(route.status).toBe(201);
    routeId = route.body.id;
    const planId = route.body.planId;
    const address = `E2E late plan stop ${suffix}`;

    await page.goto(`/dispatch?view=traffic&planId=${planId}`);
    await page.getByTestId("dispatch-add-late-stop").click();
    await expect(page).toHaveURL(new RegExp(`/orders\\?planId=${planId}&create=1`));
    await expect(page.getByText("Lägg till ett stopp i planen")).toBeVisible();
    await page.locator('form input[name="address"]').fill(address);
    await page.locator('form input[name="latitude"]').fill("59.3293");
    await page.locator('form input[name="longitude"]').fill("18.0686");
    await page.getByRole("button", { name: /spara stopp|save stop/i }).click();
    await expect(page).toHaveURL(new RegExp(`/dispatch\\?planId=${planId}`));

    const stops = await api(page, `/api/stops?organizationId=${organizationId}`);
    expect(stops.status).toBe(200);
    const created = stops.body.find((stop: any) => stop.address === address);
    expect(created).toBeTruthy();
    stopId = created.id;
    expect(created.planningPlanId).toBe(planId);
    expect(created.routeId).toBeNull();
    await expect(page.locator(`[data-testid="unscheduled-stop-node"][data-stop-id="${stopId}"]`)).toBeVisible();
    await page.reload();
    await expect(page.locator(`[data-testid="unscheduled-stop-node"][data-stop-id="${stopId}"]`)).toBeVisible();
  } finally {
    if (!page.isClosed()) {
      if (stopId) await api(page, `/api/stops/${stopId}`, "DELETE");
      if (routeId) await api(page, `/api/routes/${routeId}`, "DELETE");
      if (vehicleId) await api(page, `/api/vehicles/${vehicleId}`, "DELETE");
    }
  }
});