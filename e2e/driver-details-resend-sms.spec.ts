import { expect, type Page } from "@playwright/test";
import { login, test } from "./auth";

test("edits a driver phone, reopens details, and explicitly resends route SMS", async ({
  page,
}) => {
  const organizationId = "00000000-0000-4000-8000-000000000001";
  const routeId = "00000000-0000-4000-8000-000000000002";
  const driverId = "00000000-0000-4000-8000-000000000003";
  const vehicleId = "00000000-0000-4000-8000-000000000004";
  const initialPhone = "+46 70 111 2233";
  const updatedPhone = "+46 70 444 5566";
  let driverPhone = initialPhone;
  let resendRequests = 0;
  const dispatchRequests: string[] = [];

  const driver = () => ({
    id: driverId,
    organizationId,
    name: "E2E SMS Driver",
    phone: driverPhone,
    email: "sms-driver@example.test",
    vehicleId,
    isActive: true,
    workStartTime: "07:00",
    workEndTime: "17:00",
    driverRole: "driver",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
  const vehicle = {
    id: vehicleId,
    organizationId,
    name: "E2E SMS Van",
    licensePlate: "E2E-SMS",
    routeColor: "#2563eb",
    sortOrder: 1,
    vehicleType: "fossil",
    capacityKg: 1000,
    capacityVolume: 10,
    isActive: true,
    createdAt: "2026-01-01T00:00:00.000Z",
  };
  const route = {
    id: routeId,
    planId: "00000000-0000-4000-8000-000000000005",
    organizationId,
    vehicleId,
    name: "E2E SMS Route",
    status: "in_progress",
    manualReviewRequired: false,
    manualReviewedAt: null,
    planRevision: 3,
    handoffStatus: "sent",
    handoffVersion: 3,
    handoffDriverId: driverId,
    sentAt: "2026-01-01T08:00:00.000Z",
    receivedAt: null,
    openedAt: null,
    acceptedAt: null,
    rejectedAt: null,
    rejectionReason: null,
    date: "2026-01-01T00:00:00.000Z",
    totalDistanceKm: 0,
    totalDurationMin: 0,
    totalStops: 0,
    co2EmissionsKg: 0,
    plannerItinerary: [],
    geographicOverlapExplanation: null,
    workdayTimeline: [],
    workdaySummary: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T08:00:00.000Z",
  };

  page.on("request", (request) => {
    if (
      request.method() === "POST" &&
      new URL(request.url()).pathname === `/api/routes/${routeId}/dispatch`
    ) {
      dispatchRequests.push(request.url());
    }
  });

  await page.route("**/api/drivers**", async (routeHandler) => {
    const request = routeHandler.request();
    if (request.method() === "PUT" && new URL(request.url()).pathname === `/api/drivers/${driverId}`) {
      const body = request.postDataJSON() as { phone?: string | null };
      driverPhone = body.phone ?? "";
      await routeHandler.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(driver()),
      });
      return;
    }
    if (request.method() === "GET") {
      await routeHandler.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([driver()]),
      });
      return;
    }
    await routeHandler.continue();
  });

  await page.route("**/api/vehicles**", async (routeHandler) => {
    if (routeHandler.request().method() === "GET") {
      await routeHandler.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([vehicle]),
      });
      return;
    }
    await routeHandler.continue();
  });

  await page.route("**/api/stops**", async (routeHandler) => {
    if (routeHandler.request().method() === "GET") {
      await routeHandler.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([]),
      });
      return;
    }
    await routeHandler.continue();
  });

  await page.route("**/api/routes**", async (routeHandler) => {
    const request = routeHandler.request();
    const pathname = new URL(request.url()).pathname;
    if (request.method() === "POST" && pathname === `/api/routes/${routeId}/resend-sms`) {
      resendRequests += 1;
      await routeHandler.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          routeId,
          driverId,
          status: "sent",
          sent: true,
          code: "sms_sent",
          message: "SMS sent.",
        }),
      });
      return;
    }
    if (request.method() !== "GET") {
      await routeHandler.continue();
      return;
    }
    if (pathname === `/api/routes/${routeId}/incidents`) {
      await routeHandler.fulfill({
        status: 200,
        contentType: "application/json",
        body: "[]",
      });
      return;
    }
    if (pathname === "/api/routes") {
      await routeHandler.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify([route]),
      });
      return;
    }
    await routeHandler.continue();
  });
  await page.route("**/api/routes/**/dispatch", async (routeHandler) => {
    dispatchRequests.push(routeHandler.request().url());
    await routeHandler.fulfill({
      status: 500,
      contentType: "application/json",
      body: JSON.stringify({ error: "dispatch endpoint must not be called by this test" }),
    });
  });

  // The route and SMS provider are entirely stubbed: this test never dispatches
  // a route or sends a real text message.
  await page.setViewportSize({ width: 1440, height: 900 });
  await login(page, "/dispatch", "dispatch-split");

  const driverName = page.getByTestId("dispatch-driver-name").filter({ hasText: driver().name });
  await expect(driverName).toBeVisible();
  await driverName.click();

  const dialog = page.getByRole("dialog");
  await expect(dialog).toBeVisible();
  const phoneInput = dialog.getByLabel(/phone number|telefonnummer/i);
  await expect(phoneInput).toHaveValue(initialPhone);
  await phoneInput.fill(updatedPhone);
  await dialog.getByRole("button", { name: /save|spara/i }).click();
  await expect(dialog.getByText(/phone number saved|telefonnumret sparades/i)).toBeVisible();

  await dialog.getByRole("button", { name: /close|stäng/i }).click();
  await expect(dialog).toBeHidden();

  await driverName.click();
  const reopenedDialog = page.getByRole("dialog");
  await expect(reopenedDialog.getByLabel(/phone number|telefonnummer/i)).toHaveValue(updatedPhone);
  await reopenedDialog
    .getByRole("button", { name: /resend route sms|skicka rutt-sms igen/i })
    .click();
  await expect(reopenedDialog.getByText(/The SMS request was accepted by the provider|SMS-begäran accepterades av leverantören/i)).toBeVisible();

  expect(resendRequests).toBe(1);
  expect(dispatchRequests).toEqual([]);
});