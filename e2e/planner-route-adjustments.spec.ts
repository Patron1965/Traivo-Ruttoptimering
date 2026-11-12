import { expect, type BrowserContext, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { authenticatedOrganizationId, login, test } from "./auth";

test.setTimeout(240_000);

async function api(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<{ status: number; body: any }> {
  const response = await page.request.fetch(path, {
    method,
    ...(body === undefined ? {} : { data: body }),
  });
  return {
    status: response.status(),
    body: await response.json().catch(() => null),
  };
}

async function loginAtPlanner(page: Page): Promise<void> {
  await login(page, "/planner", "planner-header");
}

async function plannerAssignments(page: Page): Promise<Array<{ routeId: string; stopIds: string[] }>> {
  return page.getByTestId("planner-route").evaluateAll((cards) =>
    cards.map((card) => ({
      routeId: card.getAttribute("data-route-id") ?? "",
      stopIds: Array.from(card.querySelectorAll<HTMLElement>('[data-testid="planner-stop"]'))
        .map((stop) => stop.getAttribute("data-stop-id") ?? ""),
    })).sort((left, right) => left.routeId.localeCompare(right.routeId)),
  );
}

async function reorderFirstTwoStops(page: Page, routeId: string): Promise<void> {
  const sourceCard = page.locator(
    `[data-testid="planner-route"][data-route-id="${routeId}"]`,
  );
  const draggable = sourceCard.getByTestId("planner-stop").first();
  const dragHandle = draggable.getByTestId("planner-drag-handle");
  const destinationStop = sourceCard.getByTestId("planner-stop").nth(1);
  await dragHandle.scrollIntoViewIfNeeded();
  await destinationStop.scrollIntoViewIfNeeded();
  const [dragBox, dropBox] = await Promise.all([
    dragHandle.boundingBox(),
    destinationStop.boundingBox(),
  ]);
  expect(dragBox).not.toBeNull();
  expect(dropBox).not.toBeNull();
  await page.mouse.move(dragBox!.x + dragBox!.width / 2, dragBox!.y + dragBox!.height / 2);
  await page.mouse.down();
  await page.waitForTimeout(150);
  await page.mouse.move(
    dragBox!.x + dragBox!.width / 2,
    dragBox!.y + dragBox!.height / 2 + 12,
    { steps: 4 },
  );
  await page.mouse.move(
    dropBox!.x + dropBox!.width / 2,
    dropBox!.y + dropBox!.height - 4,
    { steps: 12 },
  );
  await page.mouse.up();
}

async function reorderFirstTwoStopsWithKeyboard(page: Page, routeId: string): Promise<void> {
  const sourceCard = page.locator(
    `[data-testid="planner-route"][data-route-id="${routeId}"]`,
  );
  const dragHandle = sourceCard
    .getByTestId("planner-stop")
    .first()
    .getByTestId("planner-drag-handle");
  await dragHandle.scrollIntoViewIfNeeded();
  await dragHandle.focus();
  await page.keyboard.press("Space");
  await page.keyboard.press("ArrowDown");
  await page.keyboard.press("Space");
}

test("Planner drag saves and resumes the exact persisted plan", async ({ browser, page }, testInfo) => {
  test.setTimeout(240_000);
  await page.setViewportSize({ width: 1440, height: 1000 });
  const baseURL = testInfo.project.use.baseURL;
  if (typeof baseURL !== "string") {
    throw new Error("Playwright project baseURL is required for the second planner context.");
  }
  const suffix = randomUUID().slice(0, 8);
  const vehicleIds: string[] = [];
  const driverIds: string[] = [];
  const stopIds: string[] = [];
  const routeIds: string[] = [];
  let concurrentContext: BrowserContext | undefined;

  try {
    await loginAtPlanner(page);
    const organizationId = await authenticatedOrganizationId(page);

    // Two capacity-constrained vehicles force the four 10 kg stops across both routes.
    for (let index = 0; index < 4; index++) {
      const vehicle = await api(page, "/api/vehicles", "POST", {
        organizationId,
        name: `E2E planner vehicle ${suffix}-${index + 1}`,
        licensePlate: `PLN-${suffix}-${index + 1}`,
        vehicleType: "fossil",
        capacityKg: 25,
        capacityVolume: 10,
        isActive: true,
        driver: { name: `E2E planner driver ${suffix}-${index + 1}` },
      });
      expect(vehicle.status).toBe(201);
      vehicleIds.push(vehicle.body.id);

      const driver = vehicle.body.resourceProfile;
      expect(driver?.id).toBeTruthy();
      expect(driver.vehicleId).toBe(vehicle.body.id);
      driverIds.push(driver.id);
    }

    for (let index = 0; index < 4; index++) {
      const stop = await api(page, "/api/stops", "POST", {
        organizationId,
        address: `E2E planner stop ${suffix}-${index + 1}`,
        latitude: 59.3293 + index * 0.004,
        longitude: 18.0686 + index * 0.004,
        jobType: "delivery",
        weightKg: 10,
        volumeM3: 0.1,
        serviceDurationMin: 5,
      });
      expect(stop.status).toBe(201);
      stopIds.push(stop.body.id);
    }

    await page.reload();
    await page.getByTestId("tab-source-resources").click();
    for (const vehicleId of vehicleIds) {
      await page.getByTestId(`checkbox-resource-${vehicleId}`).click();
    }
    await page.getByTestId("tab-source-jobs").click();
    for (const stopId of stopIds) {
      await page.getByTestId(`checkbox-job-${stopId}`).click();
    }
    await page.getByTestId("button-build-proposal").click();
    await page.getByTestId("planner-generate-routes").click();
    await expect(page.getByTestId("planner-route")).toHaveCount(2);
    await expect(page.getByTestId("geographic-overlap-explanation")).toHaveCount(2);

    const beforeDrag = await plannerAssignments(page);
    expect(beforeDrag.flatMap((route) => route.stopIds).sort()).toEqual([...stopIds].sort());
    const planId = await page.getByTestId("planner-route").first().getAttribute("data-plan-id");
    const source = beforeDrag.find((route) => route.stopIds.length > 1);
    expect(source).toBeDefined();
    routeIds.push(...beforeDrag.map((route) => route.routeId));

    await reorderFirstTwoStops(page, source!.routeId);

    await expect(page.getByTestId("planner-save-status")).toContainText("Ändringarna är sparade.");
    await expect(page.getByTestId("geographic-overlap-explanation")).toHaveCount(0);
    const expectedAssignments = await plannerAssignments(page);
    expect(expectedAssignments.flatMap((route) => route.stopIds).sort()).toEqual([...stopIds].sort());
    expect(expectedAssignments.find((route) => route.routeId === source!.routeId)?.stopIds)
      .not.toEqual(source!.stopIds);

    const savedStops = await api(page, `/api/stops?organizationId=${organizationId}`);
    expect(savedStops.status).toBe(200);
    const savedById = new Map(savedStops.body.map((stop: any) => [stop.id, stop]));
    for (const route of expectedAssignments) {
      route.stopIds.forEach((stopId, index) => {
        expect(savedById.get(stopId)).toMatchObject({
          routeId: route.routeId,
          sequenceOrder: index + 1,
        });
      });
    }

    await page.reload();
    const resume = page
      .getByTestId("resumable-plan")
      .getByTestId("button-resume-plan");
    await expect(resume).toBeVisible();
    await expect(page.getByTestId("resumable-plan")).toHaveAttribute("data-plan-id", planId!);
    await resume.click();
    await expect(page.getByTestId("planner-route")).toHaveCount(2);
    expect(await plannerAssignments(page)).toEqual(expectedAssignments);

    const conflictSource = expectedAssignments.find((route) => route.stopIds.length > 1);
    expect(conflictSource).toBeDefined();
    concurrentContext = await browser.newContext({
      baseURL,
      ignoreHTTPSErrors: testInfo.project.use.ignoreHTTPSErrors === true,
      viewport: { width: 1440, height: 1000 },
    });
    const concurrentPage = await concurrentContext.newPage();
    await loginAtPlanner(concurrentPage);
    await concurrentPage
      .getByTestId("resumable-plan")
      .getByTestId("button-resume-plan")
      .click();
    await expect(concurrentPage.getByTestId("planner-route")).toHaveCount(2);

    await page.bringToFront();
    const firstConcurrentSave = page.waitForResponse(
      (response) =>
        response.request().method() === "POST"
        && response.url().includes("/api/import/route-adjustments"),
      { timeout: 30_000 },
    );
    await reorderFirstTwoStops(page, conflictSource!.routeId);
    expect((await firstConcurrentSave).status()).toBe(200);
    await expect(page.getByTestId("planner-save-status")).toContainText("Ändringarna är sparade.");
    const latestAssignments = await plannerAssignments(page);
    expect(latestAssignments).not.toEqual(expectedAssignments);

    await concurrentPage.bringToFront();
    const staleConcurrentSave = concurrentPage.waitForResponse(
      (response) =>
        response.request().method() === "POST"
        && response.url().includes("/api/import/route-adjustments"),
      { timeout: 30_000 },
    );
    await reorderFirstTwoStopsWithKeyboard(concurrentPage, conflictSource!.routeId);
    const staleResponse = await staleConcurrentSave;
    // The request is the attempted plan. Reading the DOM immediately after the
    // drop can race with React's render and capture the pre-drop order instead.
    const attemptedAssignments = staleResponse.request().postDataJSON().routes
      .map((route: { routeId: string; stopIds: string[] }) => ({
        routeId: route.routeId, stopIds: route.stopIds,
      }))
      .sort((left: { routeId: string }, right: { routeId: string }) => left.routeId.localeCompare(right.routeId));
    expect(staleResponse.status()).toBe(409);
    const conflictDialog = concurrentPage.getByTestId("planner-conflict-dialog");
    await expect(conflictDialog).toBeVisible();
    expect(await plannerAssignments(concurrentPage)).toEqual(attemptedAssignments);
    await conflictDialog.getByTestId("planner-load-latest").click();
    await expect(conflictDialog).toBeHidden();
    await expect.poll(() => plannerAssignments(concurrentPage)).toEqual(latestAssignments);

    const previewSource = latestAssignments.find((route) => route.stopIds.length > 1)!;
    const unchangedBeforePreview = latestAssignments.filter((route) => route.routeId !== previewSource.routeId);
    await page.bringToFront();
    // The preview action is a dropdown item and is only mounted after the
    // route's optimization-actions menu is opened. Selecting it opens the
    // confirmation dialog; the API request is sent only by its explicit
    // "Skapa förhandsvisning" action.
    await page.getByTestId(`button-reoptimization-menu-${previewSource.routeId}`).click();
    await expect(
      page.getByTestId(`preview-remaining-route-${previewSource.routeId}`),
    ).toBeVisible();
    await page.getByTestId(`preview-remaining-route-${previewSource.routeId}`).click();
    const setupDialog = page.getByTestId("reoptimization-dialog");
    await expect(setupDialog).toBeVisible();
    const previewResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST"
        && response.url().includes(`/api/routes/${previewSource.routeId}/reoptimization/preview`),
      { timeout: 30_000 },
    );
    await setupDialog.getByTestId("button-create-route-preview").click();
    const previewResponse = await previewResponsePromise;
    expect(previewResponse.status(), await previewResponse.text()).toBe(200);
    const previewDialog = page.getByTestId("remaining-route-preview-dialog");
    await expect(previewDialog).toBeVisible();
    const proposedStopIds = await previewDialog
      .getByTestId("remaining-route-preview-order")
      .locator("li:not(:has-text('Ionity'))")
      .evaluateAll((entries) => entries.map((entry) => entry.getAttribute("data-stop-id") ?? ""));
    expect([...proposedStopIds].sort()).toEqual([...previewSource.stopIds].sort());
    expect(await plannerAssignments(page)).toEqual(latestAssignments);
    const applyResponsePromise = page.waitForResponse(
      (response) =>
        response.request().method() === "POST"
        && response.url().includes(`/api/routes/${previewSource.routeId}/reoptimization/apply`),
      { timeout: 30_000 },
    );
    await previewDialog.getByTestId("apply-remaining-route-preview").click();
    const applyResponse = await applyResponsePromise;
    expect(applyResponse.status(), await applyResponse.text()).toBe(200);
    await expect(previewDialog).toBeHidden();
    // Closing the dialog precedes the invalidated route query resolving.
    // Wait for the persisted ordering to reach the UI, not only the POST.
    await expect.poll(async () => (await plannerAssignments(page))
      .find((route) => route.routeId === previewSource.routeId)?.stopIds)
      .toEqual(proposedStopIds);
    const afterSingleRouteApply = await plannerAssignments(page);
    expect(afterSingleRouteApply.find((route) => route.routeId === previewSource.routeId)?.stopIds)
      .toEqual(proposedStopIds);
    expect(afterSingleRouteApply.filter((route) => route.routeId !== previewSource.routeId))
      .toEqual(unchangedBeforePreview);

  } finally {
    await concurrentContext?.close();
    for (const routeId of routeIds) {
      await api(page, `/api/routes/${routeId}`, "DELETE");
    }
    if (stopIds.length) {
      await api(page, "/api/stops/bulk-delete", "POST", { stopIds });
    }
    for (const driverId of driverIds) {
      await api(page, `/api/drivers/${driverId}`, "DELETE");
    }
    for (const vehicleId of vehicleIds) {
      await api(page, `/api/vehicles/${vehicleId}`, "DELETE");
    }
  }
});
