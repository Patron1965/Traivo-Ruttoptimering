import { expect, type Page } from "@playwright/test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomUUID } from "node:crypto";
import { authenticatedOrganizationId, login, test } from "./auth";

async function api(page: Page, path: string) {
  const response = await page.evaluate(async (path) => {
    const result = await fetch(path, { credentials: "include" });
    return { status: result.status, body: await result.json() };
  }, path);
  expect(response.status, JSON.stringify(response.body)).toBe(200);
  return response.body;
}

test("recurring stops retain priority and survive adding to a draft and open plan", async ({ page }) => {
  test.setTimeout(120_000);
  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);
  const customerId = randomUUID();
  const siteId = randomUUID();
  const draftId = randomUUID();
  const planId = randomUUID();
  const date = "2026-10-26";
  const name = `Register ${customerId.slice(0, 8)}`;
  // Synthetic, verified data avoids contacting geocoding or notification providers.
  // The auth fixture disposes this tenant and its data at worker teardown.
  const seed = `
    import { db, pool, customersTable, customerSitesTable, planningDraftsTable, routesTable } from "@workspace/db";
    void (async () => {
      const organizationId = ${JSON.stringify(organizationId)};
      await db.insert(customersTable).values({ id: "${customerId}", organizationId, name: "${name}" });
      await db.insert(customerSitesTable).values({
        id: "${siteId}", customerId: "${customerId}", organizationId,
        name: "Prioriterat registerstopp", addressInput: "Synthetic Stockholm address",
        address: "Synthetic Stockholm address", latitude: 59.3293, longitude: 18.0686,
        verificationStatus: "exact", isPrioritized: true, serviceDurationMin: 17,
        instructions: "Synthetic recurring instructions",
        verificationMetadata: { provider: "nominatim", source: "cache", displayName: "Synthetic Stockholm address", query: "Synthetic Stockholm address" }
      });
      await db.insert(planningDraftsTable).values({
        id: "${draftId}", organizationId, name: "Register draft",
        startAt: new Date("${date}T00:00:00Z"), state: { step: 5, source: "manual", selectedStopIds: [] }
      });
      await db.insert(routesTable).values({
        organizationId, planId: "${planId}", name: "Register plan",
        date: new Date("${date}T00:00:00Z"), status: "draft"
      });
      await pool.end();
    })().catch(e => { console.error(e); process.exit(1); });
  `;
  await promisify(execFile)("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", seed]);
  await page.goto("/customers");
  await page.getByRole("button", { name: new RegExp(name) }).click();
  await expect(page.getByRole("button", { name: "Lägg till stopp", exact: true })).toBeVisible();
  await expect(page.getByTestId(`badge-site-prioritized-${siteId}`)).toBeVisible();
  await page.getByRole("button", { name: "Lägg till stopp", exact: true }).click();
  await expect(page.getByRole("dialog")).toBeVisible();
  await page.keyboard.press("Escape");

  const chooseAndSubmit = async () => {
    await page.getByTestId("input-stop-register-search").fill(name);
    await page.getByTestId(`checkbox-stop-register-group-${customerId}`).click();
    await expect(page.getByTestId(`checkbox-stop-register-site-${siteId}`)).toBeChecked();
    await page.getByTestId("button-stop-register-review").click();
    await page.getByTestId("button-stop-register-submit").click();
    await expect(page.getByTestId("stop-register-dialog")).not.toBeVisible();
  };

  await page.goto(`/routes/drafts/${draftId}`);
  await page.getByTestId("button-import-stop-register").click();
  await chooseAndSubmit();
  let stops = await api(page, `/api/stops?organizationId=${organizationId}`);
  const draftVisit = stops.find((stop: any) => stop.customerSiteId === siteId);
  expect(draftVisit.priority).toBe(1);
  expect(draftVisit.serviceDurationMin).toBe(17);
  await page.reload();
  await page.getByTestId("button-import-stop-register").click();
  await page.getByTestId(`checkbox-stop-register-site-${siteId}`).click();
  await page.getByTestId("button-stop-register-review").click();
  await page.getByTestId("button-stop-register-submit").click();
  await expect(page.getByTestId("stop-register-duplicate-warning")).toBeVisible();
  await expect(page.getByTestId("button-stop-register-submit")).toBeDisabled();
  await page.keyboard.press("Escape");

  await page.goto(`/dispatch?view=traffic&planId=${planId}`);
  await page.getByTestId("dispatch-extra-tools").locator("summary").click();
  await page.getByTestId("dispatch-stop-register").click();
  await chooseAndSubmit();
  stops = await api(page, `/api/stops?organizationId=${organizationId}`);
  const planVisit = stops.find((stop: any) => stop.customerSiteId === siteId && stop.planningPlanId === planId);
  expect(planVisit).toBeTruthy();
  expect(planVisit.priority).toBe(1);
  expect(planVisit.routeId).toBeNull();
  expect(planVisit.id).not.toBe(draftVisit.id);
  await page.reload();
  await expect(page.locator(`[data-testid="unscheduled-stop-node"][data-stop-id="${planVisit.id}"]`)).toBeVisible();
});
