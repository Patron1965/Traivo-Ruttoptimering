import { randomUUID } from "node:crypto";
import { expect, test, type Page } from "@playwright/test";
import { cleanupDisposableAuthFixture, provisionDisposableAuthFixture } from "./planning-draft-fixture";
import { readResumeEvidence, seedResumeRoute } from "./driver-resume-fixture";

const mobileUrl = process.env.E2E_MOBILE_BASE_URL ??
  (process.env.REPLIT_EXPO_DEV_DOMAIN ? `https://${process.env.REPLIT_EXPO_DEV_DOMAIN}` : undefined);

async function resume(page: Page) {
  await page.evaluate(() => {
    if (!navigator.onLine) throw new Error("Resume regression must run online");
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "hidden" });
    document.dispatchEvent(new Event("visibilitychange"));
    Object.defineProperty(document, "visibilityState", { configurable: true, get: () => "visible" });
    document.dispatchEvent(new Event("visibilitychange"));
  });
}

test.describe("SMS device session resumes while still online", () => {
  test.skip(!mobileUrl, "Set E2E_MOBILE_BASE_URL to the running Expo web app");
  test.setTimeout(180_000);

  for (const conflict of [false, true]) {
    test(conflict ? "generation conflict never automatically replays a committed start"
      : "transport failure on resume recovers for start, report and planner position", async ({ browser, request }, testInfo) => {
      const auth = await provisionDisposableAuthFixture(randomUUID());
      const context = await browser.newContext({
        viewport: { width: 402, height: 874 }, permissions: ["geolocation"],
        geolocation: { latitude: 59.3293, longitude: 18.0686, accuracy: 5 },
      });
      let releaseStart: (() => void) | undefined;
      try {
        const f = await seedResumeRoute(auth, mobileUrl!);
        const login = await request.post("/api/auth/login", { data: { email: auth.email, password: auth.password } });
        expect(login.status()).toBe(200);
        const planner = async (path: string) => {
          const response = await request.get(path);
          expect(response.status()).toBe(200);
          return response.json();
        };
        const page = await context.newPage();
        const writes: string[] = [];
        page.on("request", r => { if (r.method() === "POST") writes.push(new URL(r.url()).pathname); });
        await page.goto(f.activationUrl);
        await expect(page.getByText("Synthetic resume stop 1", { exact: true }).first()).toBeVisible();
        expect((await planner(`/api/routes/${f.routeId}`)).handoffVersion).toBe(0);
        expect((await planner(`/api/routes/${f.routeId}`)).handoffStatus).toBe("accepted");

        let failed = 0;
        await page.route("**/api/auth/me", async route => {
          failed++;
          await route.abort("connectionreset");
        }, { times: 1 });
        await resume(page);
        await expect.poll(() => failed).toBe(1);
        // Wait for the failed verification to settle, not merely for interception.
        await expect(page.getByTestId("offline-session-banner")).toBeVisible();
        expect(await page.evaluate(() => navigator.onLine)).toBe(true);

        let committed = false;
        if (conflict) {
          await page.route("**/api/tracking/route-session", async route => {
            const response = await route.fetch();
            expect(response.ok()).toBe(true);
            committed = true;
            await new Promise<void>(resolve => { releaseStart = resolve; });
            await route.fulfill({ response });
          }, { times: 1 });
        }
        await page.getByText("Starta arbete", { exact: true }).click();
        if (conflict) {
          await expect.poll(() => committed && !!releaseStart).toBe(true);
          // A fresh verification increments the API generation while the POST
          // response is held. The real server has already committed this start.
          const verified = page.waitForResponse(r => r.url().endsWith("/api/auth/me") && r.status() === 200);
          await resume(page);
          await verified;
          await expect(page.getByTestId("offline-session-banner")).toHaveCount(0);
          releaseStart!();
          await expect(page.getByText(/Sessionen har ändrats|försök igen|Försök igen/).first()).toBeVisible();
          // Exercise another recovery cycle; it must not replay the mutation.
          await resume(page);
          await page.waitForTimeout(2500);
          expect(writes.filter(path => path === "/api/tracking/route-session")).toHaveLength(1);
          expect(writes.filter(path => path.endsWith("/execution/start"))).toHaveLength(0);
          expect(writes.filter(path => path.endsWith("/execution-events"))).toHaveLength(0);
        } else {
          await expect(page.getByText("Slutför arbete", { exact: true })).toBeVisible();
          await expect.poll(async () => {
            const positions = await planner("/api/vehicles/positions");
            return positions.some((p: any) => p.vehicleId === f.vehicleId && p.isRealGps && p.routeId === f.routeId &&
              Math.abs(p.latitude - 59.3293) < 0.0001 && Math.abs(p.longitude - 18.0686) < 0.0001);
          }, { timeout: 30_000 }).toBe(true);
          await page.getByTestId(`report-stop-${f.stopId}`).click();
          await page.getByTestId(`report-completed-${f.stopId}`).click();
          await page.getByTestId("save-stop-report").click();
          const confirmation = page.getByRole("button", { name: "Till ruttöversikten", exact: true }).locator("..");
          await expect(confirmation).toContainText("Synkat med trafikledningen", { timeout: 30_000 });
          await expect.poll(async () => (await planner(`/api/stops/${f.stopId}`)).status).toBe("completed");
          expect(writes.filter(path => path === "/api/tracking/route-session")).toHaveLength(1);
        }
        expect((await planner(`/api/routes/${f.routeId}/execution`)).status).toBe("active");
        expect(await readResumeEvidence(auth)).toEqual({ executions: "1", starts: "1", notifications: "0" });
        await page.screenshot({ path: testInfo.outputPath("resume-result.png") });
      } finally {
        releaseStart?.();
        await context.close();
        await cleanupDisposableAuthFixture(auth);
      }
    });
  }
});
