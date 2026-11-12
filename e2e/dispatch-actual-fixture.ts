import { expect, test as base, type APIRequestContext } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cleanupDisposableAuthFixture, provisionDisposableAuthFixture } from "./planning-draft-fixture";

export async function jsonApi(request: APIRequestContext, path: string, method = "GET", data?: unknown) {
  const response = await request.fetch(path, { method, data });
  const body = await response.json();
  expect(response.ok(), `${method} ${path}: ${response.status()} ${JSON.stringify(body)}`).toBe(true);
  return { status: response.status(), body };
}

export const test = base.extend<{
  actualFixture: { routeId: string; planId: string; stopIds: string[]; planVersion: number };
}>({
  actualFixture: async ({ page }, use, testInfo) => {
    const auth = await provisionDisposableAuthFixture(randomUUID());
    try {
      // A separate tenant, no recipients, no webhooks/integrations. Do not
      // mutate customer settings or use bootstrap/acceptance credentials.
      await promisify(execFile)("pnpm", ["--filter", "@workspace/scripts", "exec", "tsx", "--eval", `
        import { pool } from "@workspace/db";
        (async () => { try {
          const org = await pool.query(
            "UPDATE organizations SET sms_enabled=false, notify_sms_approaching=false, notify_sms_delivered=false, notify_sms_failed=false WHERE id=$1 RETURNING id",
            [process.env.TEST_ORG]);
          if (org.rowCount !== 1) throw new Error("Synthetic tenant missing");
          const links = await pool.query(
            "SELECT (SELECT count(*) FROM webhooks WHERE organization_id=$1) + (SELECT count(*) FROM shopify_integrations WHERE organization_id=$1) AS total",
            [process.env.TEST_ORG]);
          if (Number(links.rows[0].total) !== 0) throw new Error("External integrations in synthetic tenant");
        } finally { await pool.end(); } })().catch(e => { console.error(e); process.exitCode=1; });
      `], { env: { ...process.env, TEST_ORG: auth.organizationId } });
      await page.goto("/routes/create");
      await page.locator("#email").fill(auth.email);
      await page.locator("#password").fill(auth.password);
      await page.locator("#password").press("Enter");
      await expect(page.getByTestId("input-draft-name")).toBeVisible();
      const api = (path: string, method = "GET", data?: unknown) => jsonApi(page.request, path, method, data);
      const { body: vehicle } = await api("/api/vehicles", "POST", {
        organizationId: auth.organizationId, name: "Synthetic actual-time vehicle",
        licensePlate: `E2E-${randomUUID().slice(0, 8)}`, vehicleType: "fossil",
        capacityKg: 1000, capacityVolume: 30, isActive: true,
      });
      const { body: drivers } = await api(`/api/drivers?organizationId=${auth.organizationId}`);
      const matches = drivers.filter((driver: { vehicleId: string }) => driver.vehicleId === vehicle.id);
      expect(matches).toHaveLength(1);
      const driver = matches[0];
      expect(driver.phone ?? null).toBeNull();
      const stopIds: string[] = [];
      for (let i = 0; i < 4; i++) {
        const { body: stop } = await api("/api/stops", "POST", {
          organizationId: auth.organizationId, address: `Synthetic actual-time stop ${i + 1}`,
          latitude: 59.3293 + i * 0.0002, longitude: 18.0686 + i * 0.0002,
          jobType: "delivery", serviceDurationMin: 5,
        });
        stopIds.push(stop.id);
      }
      const stockholmDay = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(new Date());
      const planDate = new Date(`${stockholmDay}T00:00:00.000Z`);
      if (testInfo.title.includes("skipped")) planDate.setUTCDate(planDate.getUTCDate() - 1);
      const date = planDate.toISOString();
      const { body: draft } = await api("/api/planning-drafts", "POST", {
        name: "Synthetic actual-time regression", startAt: date, state: { step: 6 },
      });
      const { body: plan } = await api("/api/import/route-plans", "POST", {
        draftId: draft.id, stopIds, pairs: [{ vehicleId: vehicle.id, driverId: driver.id }],
        date, depotLatitude: 59.3293, depotLongitude: 18.0686,
      });
      expect(plan.routes).toHaveLength(1);
      const { routeId, planId, planRevision } = plan.routes[0];
      await api(`/api/import/route-plans/${planId}/approve`, "POST", {
        routes: [{ routeId, planRevision, driverId: driver.id }],
      });
      await api(`/api/routes/${routeId}/dispatch`, "POST", { driverId: driver.id, planRevision });
      await use({ routeId, planId, stopIds, planVersion: planRevision });
    } finally {
      // Playwright fixture teardown has its own timeout, even if a UI assertion
      // times out. All data removal is restricted to this disposable tenant.
      await cleanupDisposableAuthFixture(auth);
    }
  },
});
