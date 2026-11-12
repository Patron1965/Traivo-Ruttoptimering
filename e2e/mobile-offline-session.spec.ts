import { expect, test, type Page } from "@playwright/test";

test.describe("driver offline reopening boundary", () => {
  test.skip(!process.env.E2E_MOBILE_BASE_URL, "Set E2E_MOBILE_BASE_URL for the Expo fixture");

  async function fixture(page: Page) {
    let offline = false;
    let denied = false;
    let account = "a";
    let holdVerification = false;
    let releaseVerification: (() => void) | undefined;
    const requests: string[] = [];
    const user = () => ({
      id: `synthetic-user-${account}`, name: `Synthetic ${account}`, email: `${account}@example.invalid`,
      role: "driver", organizationId: `synthetic-org-${account}`, driverProfileId: `synthetic-driver-${account}`,
    });
    const route = () => ({
      id: `synthetic-route-${account}`, name: `Synthetic route ${account}`, status: "optimized",
      handoffDriverId: user().driverProfileId, vehicleId: `synthetic-vehicle-${account}`,
      organizationId: user().organizationId, date: new Date().toISOString().slice(0, 10),
      optimizedAt: new Date().toISOString(), startedAt: null, completedAt: null,
      totalDistanceKm: 10, totalDurationMin: 30, totalCo2Kg: 1, handoffStatus: "accepted",
      handoffVersion: 4, planRevision: 4, sentAt: null, receivedAt: null, openedAt: null,
      acceptedAt: new Date().toISOString(), rejectedAt: null, rejectionReason: null,
    });
    const stop = () => ({
      id: `synthetic-stop-${account}`, routeId: route().id, address: `Synthetic address ${account}`,
      latitude: 59.3, longitude: 18, navigationVerified: true, jobType: "delivery",
      status: "pending", sequenceOrder: 1, serviceDurationMin: 10, timeWindowStart: null,
      timeWindowEnd: null, notes: null, contactName: null, contactEmail: null, completedAt: null,
      pickupAddress: null, pickupLatitude: null, pickupLongitude: null,
    });
    const session = () => ({
      idleTimeoutMin: 60, absoluteTimeoutHours: 12,
      absoluteExpiresAt: new Date(Date.now() + 12 * 3600_000).toISOString(),
    });
    await page.route("**/api/**", async (intercept) => {
      const req = intercept.request();
      const path = new URL(req.url()).pathname.replace("/api", "");
      requests.push(`${req.method()} ${path}`);
      if (offline) return intercept.abort("internetdisconnected");
      if (path === "/auth/me" && holdVerification) {
        await new Promise<void>((resolve) => { releaseVerification = resolve; });
      }
      if (path === "/auth/me" && denied) return intercept.fulfill({
        status: 401, contentType: "application/json", body: JSON.stringify({ code: "SESSION_EXPIRED" }),
      });
      let body: unknown = { ok: true };
      if (path === "/auth/login") body = { user: user(), token: `synthetic-token-${account}`, session: session() };
      else if (path === "/auth/me") body = { user: user(), session: session() };
      else if (path === `/drivers/${user().driverProfileId}`) body = {
        id: user().driverProfileId, name: user().name, email: null, phone: null,
        organizationId: user().organizationId, vehicleId: `synthetic-vehicle-${account}`,
      };
      else if (path === "/routes") body = [route()];
      else if (path === `/routes/${route().id}`) body = route();
      else if (path === `/stops/${stop().id}`) body = stop();
      else if (path.endsWith("/stops")) body = [stop()];
      else if (path.endsWith("/execution")) body = null;
      else if (path.endsWith("/execution/start")) body = {
        routeId: route().id, sessionId: "synthetic-execution", clientSessionId: "synthetic-execution",
        status: "active", startedAt: new Date().toISOString(), endedAt: null,
      };
      else if (path.endsWith("/stats")) body = {
        totalRoutes: 1, completedRoutes: 0, totalDeliveries: 1,
        completedDeliveries: 0, failedDeliveries: 0, skippedDeliveries: 0,
        onTimeRate: null, avgServiceDurationMin: null, totalDistanceKm: 10, happinessScore: null,
      };
      else if (path.endsWith("/preferences")) body = {
        id: `synthetic-preferences-${account}`, driverId: user().driverProfileId,
        preferredStartTime: null, preferredEndTime: null, maxDrivingHours: null, avoidNightDriving: false,
      };
      else if (path === "/vehicles" || path.endsWith("/incidents") || path.endsWith("/proofs")) body = [];
      else if (path.endsWith("/messages")) body = { messages: [], nextCursor: null };
      await intercept.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });
    const base = process.env.E2E_MOBILE_BASE_URL!.replace(/\/$/, "");
    await page.goto(`${base}/login`);
    async function login() {
      await page.getByPlaceholder("namn@foretag.se").fill(user().email);
      await page.getByPlaceholder("Ditt lösenord").fill("synthetic-password");
      await page.getByText("Logga in", { exact: true }).click();
      await expect(page.getByText(`Synthetic address ${account}`, { exact: true }).first()).toBeVisible();
      // Wait for the verified grant and both cache entries to finish persisting.
      await expect.poll(() => page.evaluate(() => {
        const raw = localStorage.getItem("routeai_verified_offline_session_v1");
        const user = raw && JSON.parse(raw).user;
        const cache = user && localStorage.getItem(`routeai_cache:${user.id}:${user.organizationId}`);
        return cache ? Object.keys(JSON.parse(cache)).length : 0;
      })).toBeGreaterThanOrEqual(2);
    }
    return {
      login, requests,
      setOffline: (value: boolean) => { offline = value; },
      deny: () => { denied = true; },
      switchAccount: () => { account = "b"; },
      hold: () => { holdVerification = true; },
      release: () => { holdVerification = false; releaseVerification?.(); },
    };
  }

  test("cold start keeps only owned cache and revalidates before sending queued work", async ({ page }) => {
    const f = await fixture(page);
    await f.login();
    await page.evaluate(() => {
      // Cache older than the previous ten-minute limit must remain usable
      // within the explicit offline grant.
      const key = "routeai_cache:synthetic-user-a:synthetic-org-a";
      const cache = JSON.parse(localStorage.getItem(key)!);
      for (const entry of Object.values(cache) as Array<{ timestamp: number }>) entry.timestamp -= 20 * 60_000;
      localStorage.setItem(key, JSON.stringify(cache));
      localStorage.setItem("routeai_offline_queue:synthetic-user-a:synthetic-org-a", JSON.stringify([{
        id: "synthetic-event-a", type: "updateStopStatus", stopId: "synthetic-stop-a",
        routeId: "synthetic-route-a", status: "completed", timestamp: Date.now(), planVersion: 4,
        syncStatus: "pending",
      }]));
      localStorage.setItem("routeai_offline_queue:synthetic-user-b:synthetic-org-b", JSON.stringify([{
        id: "synthetic-event-b", type: "updateStopStatus", stopId: "synthetic-stop-b",
        status: "completed", timestamp: Date.now(), planVersion: 4, syncStatus: "pending",
      }]));
    });
    f.setOffline(true);
    await page.reload();
    await expect(page.getByTestId("offline-session-banner")).toContainText("Sparat arbete öppnat offline");
    await expect(page.getByText("Synthetic address a", { exact: true }).first()).toBeVisible();
    expect(f.requests.some((path) => path.includes("/execution-events"))).toBe(false);

    f.requests.length = 0;
    f.setOffline(false);
    f.hold();
    // Simulate the device connectivity transition without preventing Expo's
    // bundled JS from loading (native apps already have their bundle locally).
    await page.evaluate(() => window.dispatchEvent(new Event("offline")));
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    await expect.poll(() => f.requests.includes("GET /auth/me")).toBe(true);
    expect(f.requests.some((path) => path.includes("/execution-events"))).toBe(false);
    f.release();
    await expect.poll(() => f.requests.includes("POST /stops/synthetic-stop-a/execution-events")).toBe(true);
    expect(f.requests.some((path) => path.includes("synthetic-stop-b"))).toBe(false);
    // Synced events are retained as local receipts, not deleted.
    await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem(
      "routeai_offline_queue:synthetic-user-a:synthetic-org-a",
    ) ?? "[]").find((item: { id: string }) => item.id === "synthetic-event-a")?.syncStatus)).toBe("synced");
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem(
      "routeai_offline_queue:synthetic-user-b:synthetic-org-b",
    ) ?? "[]")[0].id)).toBe("synthetic-event-b");
  });

  test("revoked session closes local access without sending or reassigning evidence", async ({ page }) => {
    const f = await fixture(page);
    await f.login();
    await page.evaluate(() => localStorage.setItem(
      "routeai_offline_queue:synthetic-user-a:synthetic-org-a",
      JSON.stringify([{ id: "keep-original-owner", stopId: "synthetic-stop-a", status: "completed", planVersion: 4, timestamp: Date.now() }]),
    ));
    f.setOffline(true);
    await page.reload();
    await expect(page.getByTestId("offline-session-banner")).toBeVisible();
    f.requests.length = 0;
    f.setOffline(false);
    f.deny();
    await page.evaluate(async () => {
      window.dispatchEvent(new Event("offline"));
      await new Promise((resolve) => setTimeout(resolve, 50));
      window.dispatchEvent(new Event("online"));
    });
    await expect(page.getByPlaceholder("namn@foretag.se")).toBeVisible();
    await expect.poll(() => page.evaluate(() => localStorage.getItem("routeai_verified_offline_session_v1"))).toBeNull();
    expect(f.requests.some((path) => path.includes("/execution-events"))).toBe(false);
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem(
      "routeai_offline_queue:synthetic-user-a:synthetic-org-a",
    )!)[0].id)).toBe("keep-original-owner");
    f.setOffline(true);
    await page.reload();
    await expect(page.getByPlaceholder("namn@foretag.se")).toBeVisible();
  });

  test("expired grant and logout cannot reopen another account's work", async ({ page }) => {
    const f = await fixture(page);
    await f.login();
    await page.evaluate(() => {
      const key = "routeai_verified_offline_session_v1";
      const saved = JSON.parse(localStorage.getItem(key)!);
      saved.expiresAt = Date.now() - 1;
      localStorage.setItem(key, JSON.stringify(saved));
    });
    f.setOffline(true);
    await page.reload();
    await expect(page.getByPlaceholder("namn@foretag.se")).toBeVisible();
    f.setOffline(false);
    f.switchAccount();
    await f.login();
    await expect(page.getByText("Synthetic address a", { exact: true })).toHaveCount(0);
    await page.getByRole("tab", { name: /Inställningar/ }).click();
    await page.getByText("Byt förare", { exact: true }).click();
    await expect(page.getByPlaceholder("namn@foretag.se")).toBeVisible();
    f.setOffline(true);
    await page.reload();
    await expect(page.getByPlaceholder("namn@foretag.se")).toBeVisible();
    await expect(page.getByText("Synthetic address b", { exact: true })).toHaveCount(0);
  });
});
