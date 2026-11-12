import { expect, test } from "@playwright/test";

test.describe("mobile selected route handoffDriverId regression", () => {
  test.skip(!process.env.E2E_MOBILE_BASE_URL, "Set E2E_MOBILE_BASE_URL to run the isolated Expo driver fixture");

  test("selects B across map/service, submits B plan revision, and falls back to A after refetch", async ({ page }) => {
    const base = process.env.E2E_MOBILE_BASE_URL!;
    const organizationId = "fixture-org";
    const driverId = "fixture-driver";
    const user = {
      id: "fixture-user",
      name: "Fixture Driver",
      email: "fixture-driver@example.test",
      role: "driver",
      organizationId,
      driverProfileId: driverId,
    };
    const session = {
      idleTimeoutMin: 30,
      absoluteTimeoutHours: 8,
      absoluteExpiresAt: "2030-01-01T16:00:00.000Z",
    };
    const route = (id: string, name: string, planRevision: number) => ({
      id,
      name,
      status: "optimized",
      // Deliberately use the production contract field and omit legacy driverId.
      handoffDriverId: driverId,
      vehicleId: `vehicle-${id}`,
      organizationId,
      date: "2030-01-01",
      optimizedAt: "2030-01-01T08:00:00.000Z",
      startedAt: null,
      completedAt: null,
      totalDistanceKm: 10,
      totalDurationMin: 60,
      totalCo2Kg: 1,
      handoffStatus: "accepted",
      handoffVersion: planRevision,
      planRevision,
      sentAt: null,
      receivedAt: null,
      openedAt: null,
      acceptedAt: "2030-01-01T08:00:00.000Z",
      rejectedAt: null,
      rejectionReason: null,
    });
    const routeA = route("route-a", "Route A", 11);
    const routeB = route("route-b", "Route B", 42);
    const stop = (routeId: string, id: string, address: string, latitude: number) => ({
      id,
      routeId,
      jobType: "field_service",
      address,
      navigationAddress: address,
      navigationVerified: true,
      latitude,
      longitude: 18,
      status: "pending",
      sequenceOrder: 1,
      timeWindowStart: null,
      timeWindowEnd: null,
      serviceDurationMin: 10,
      notes: null,
      contactName: null,
      contactEmail: null,
      completedAt: null,
      pickupAddress: null,
      pickupLatitude: null,
      pickupLongitude: null,
    });
    const stops = {
      "route-a": [stop("route-a", "stop-a", "A Stop", 59.3)],
      "route-b": [stop("route-b", "stop-b", "B Stop", 59.31)],
    };
    let activeRoutes = [routeA, routeB];
    const writes: Array<{ path: string; body: Record<string, unknown> }> = [];

    await page.route("**/api/**", async (intercept) => {
      const request = intercept.request();
      const url = new URL(request.url());
      const path = url.pathname;
      let body: unknown;
      if (path === "/api/auth/login") body = { user, token: "fixture-token", session };
      else if (path === "/api/auth/me") body = { user, session };
      else if (path === "/api/auth/logout") body = { ok: true };
      else if (path === "/api/drivers/fixture-driver") {
        body = { id: driverId, name: user.name, phone: null, email: user.email, organizationId, vehicleId: "vehicle-route-a" };
      } else if (path === "/api/routes") body = activeRoutes;
      else if (path === "/api/routes/route-a") body = routeA;
      else if (path === "/api/routes/route-b") body = routeB;
      else if (path.endsWith("/execution") && request.method() === "GET") body = null;
      else if (path === "/api/routes/route-a/stops") body = stops["route-a"];
      else if (path === "/api/routes/route-b/stops") body = stops["route-b"];
      else if (path === "/api/vehicles") body = [];
      else if (path.endsWith("/incidents") || path.endsWith("/messages")) body = [];
      else if (path.endsWith("/service-report")) body = { report: null, materials: [] };
      else {
        let parsed: Record<string, unknown> = {};
        try {
          parsed = request.postDataJSON() as Record<string, unknown>;
        } catch {
          // GETs and empty writes use the empty fixture body.
        }
        writes.push({ path, body: parsed });
        body = path.endsWith("/proofs") ? [] : { ok: true };
      }
      await intercept.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
    });

    await page.goto(`${base}/login`);
    await page.getByPlaceholder("namn@foretag.se").fill(user.email);
    await page.getByPlaceholder("Ditt lösenord").fill("fixture-password");
    await page.getByText("Logga in", { exact: true }).click();
    await expect(page).toHaveURL(`${base}/`);
    await expect(page.getByText("Route A", { exact: true })).toBeVisible();

    await page.getByText("Route A", { exact: true }).click();
    await page.getByText("Route B", { exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByText("Route B", { exact: true })).toBeVisible();
    await expect(page.getByText("B Stop", { exact: true })).toBeVisible();

    await page.getByRole("tab", { name: /Karta/ }).click();
    await expect(page).toHaveURL(`${base}/map`);
    await expect(page.getByText("Route B", { exact: true })).toBeVisible();
    await expect(page.getByText("B Stop", { exact: true }).first()).toBeVisible();

    await page.getByRole("tab", { name: /Mina uppdrag/ }).click();
    await page.getByTestId("open-service-job-stop-b").click();
    await expect(page.getByTestId("service-screen")).toBeVisible();
    await expect(page.getByTestId("service-screen").getByText("B Stop", { exact: true })).toBeVisible();
    await page.getByTestId("start-work-btn").click();
    await page.getByTestId("complete-work-btn").click();
    await expect.poll(() => writes.find((write) => write.path === "/api/stops/stop-b/execution-events")?.body.planVersion).toBe(42);

    await page.getByRole("tab", { name: /Mina uppdrag/ }).click();
    activeRoutes = [routeA];
    await expect(page.getByText("Route A", { exact: true })).toBeVisible({ timeout: 25_000 });
    await expect(page.getByTestId("service-card-stop-a").getByText("A Stop", { exact: true })).toBeVisible();
    await expect(page.getByText("Route B", { exact: true })).toHaveCount(0);
  });
});