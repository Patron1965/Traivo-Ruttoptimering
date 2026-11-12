import { expect, test, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  cleanupDisposableAuthFixture,
  provisionDisposableAuthFixture,
  type DisposableAuthFixture,
} from "./planning-draft-fixture";

test.setTimeout(120_000);

let disposableFixture: DisposableAuthFixture | undefined;
// Playwright gives teardown its own timeout budget, even if the browser flow
// times out. Cleanup in the test body's finally can be interrupted with it.
test.afterEach(async () => {
  if (disposableFixture) {
    await cleanupDisposableAuthFixture(disposableFixture);
    disposableFixture = undefined;
  }
});

type ApiResult = {
  status: number;
  body: any;
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

function draftIdFromUrl(url: string): string {
  const match = url.match(/\/routes\/drafts\/([0-9a-f-]{36})(?:[/?#]|$)/i);
  if (!match) throw new Error(`Expected a planning draft URL, got ${url}`);
  return match[1];
}

function addressImportFixture(suffix: string, planningDate: string) {
  const headers = [
    "Ordernummer",
    "Namn",
    "Adress",
    "Postnummer",
    "Ort",
    "Pickup Address",
    "Datum",
    "Latitud",
    "Longitud",
    "Pickup Latitud",
    "Pickup Longitud",
    "Fragile code",
  ];
  const rows = [
    [
      `E2E-address-${suffix}-pickup`,
      `Address persistence pickup ${suffix}`,
      "GIFFELVÄGEN 19",
      "123 45",
      "Stockholm",
      "KRYDDÅRDSVÄGEN 4",
      planningDate,
      "",
      "",
      "",
      "",
      "HANDLE-WITH-CARE",
    ],
    [
      `E2E-address-${suffix}-delivery`,
      `Address persistence delivery ${suffix}`,
      "Normal delivery street 8",
      "222 33",
      "Stockholm",
      "",
      planningDate,
      "59.3297",
      "18.0689",
      "",
      "",
      "DELIVERY-ONLY",
    ],
  ];
  return {
    name: `address-persistence-${suffix}.csv`,
    mimeType: "text/csv",
    buffer: Buffer.from(
      `\uFEFF${headers.join(";")}\r\n${rows
        .map((row) => row.join(";"))
        .join("\r\n")}`,
      "utf8",
    ),
  };
}

async function loginAsDisposableUser(
  page: Page,
  fixture: DisposableAuthFixture,
): Promise<void> {
  await page.goto("/routes/create");
  await expect(page.locator("#email")).toBeVisible();
  await page.locator("#email").fill(fixture.email);
  await page.locator("#password").fill(fixture.password);
  await page.locator("#password").press("Enter");
  await expect(page.getByTestId("input-draft-name")).toBeVisible();
}

function assertDevelopmentBaseUrl(baseURL: unknown): void {
  const expected = process.env.REPLIT_DEV_DOMAIN
    ? `https://${process.env.REPLIT_DEV_DOMAIN}`
    : "";
  if (!expected || baseURL !== expected) {
    throw new Error(
      "Refusing address persistence E2E outside the development URL. "
      + "Run with E2E_BASE_URL=https://$REPLIT_DEV_DOMAIN "
      + `(got ${baseURL ?? "unset"}).`,
    );
  }
}

test("partial Google delivery and pickup candidates survive draft reopen and real import", async ({
  page,
}, testInfo) => {
  assertDevelopmentBaseUrl(testInfo.project.use.baseURL);
  const suffix = randomUUID().slice(0, 8);
  const planningDate = "2099-07-18";
  const deliveryCandidateId = `e2e-google-delivery-${suffix}`;
  const pickupCandidateId = `e2e-google-pickup-${suffix}`;
  const deliveryLatitude = 59.3301;
  const deliveryLongitude = 18.0694;
  const pickupLatitude = 59.3312;
  const pickupLongitude = 18.0705;
  const customFieldLabel = "Fragile code";
  let fixture: DisposableAuthFixture | undefined;
  let geocodeBatchCalls = 0;
  const disallowedRequests: string[] = [];

  page.on("request", (request) => {
    if (
      request.method() === "POST"
      && /\/api\/(?:routes\/[^/]+\/dispatch|import\/route-plans\/[^/]+\/approve|handoff)/.test(
        request.url(),
      )
    ) {
      disallowedRequests.push(request.url());
    }
  });

  await page.route("**/api/geocode/batch", async (route) => {
    geocodeBatchCalls += 1;
    const body = route.request().postDataJSON() as {
      addresses?: Array<{ id?: string; address?: string }>;
    };
    const results = (body.addresses ?? []).map((address) => {
      const isPickup = (address.address ?? "").includes("KRYDDÅRDSVÄGEN");
      const isDelivery = (address.address ?? "").includes("GIFFELVÄGEN");
      if (!isPickup && !isDelivery) {
        return {
          id: address.id,
          address: address.address,
          query: address.address,
          status: "matched",
          result: {
            latitude: 59.3297,
            longitude: 18.0689,
            displayName: address.address,
            source: "google",
            provider: "google",
          },
          candidates: [],
        };
      }
      return {
        id: address.id,
        address: address.address,
        query: address.address,
        status: "candidates",
        result: null,
        candidates: [
          {
            id: isPickup ? pickupCandidateId : deliveryCandidateId,
            latitude: isPickup ? pickupLatitude : deliveryLatitude,
            longitude: isPickup ? pickupLongitude : deliveryLongitude,
            displayName: isPickup ? "Kryddgårdsvägen 4" : "Griffelvägen 19",
            source: "google",
            partial: true,
          },
        ],
      };
    });
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({
        results,
        metrics: {
          requested: results.length,
          valid: results.length,
          unique: results.length,
          deduplicated: 0,
          durationMs: 0,
          cacheHits: 0,
          providerRequests: { google: 0, nominatim: 0 },
          statusCounts: {},
        },
      }),
    });
  });

  {
    fixture = await provisionDisposableAuthFixture(suffix);
    disposableFixture = fixture;
    await loginAsDisposableUser(page, fixture);

    await page.getByTestId("input-draft-name").fill(`E2E address persistence ${suffix}`);
    await page.getByTestId("input-draft-date").fill(planningDate);
    await page.getByTestId("button-draft-continue").click();
    await page.getByTestId("button-draft-start-import").click();
    await expect(page).toHaveURL(/\/routes\/drafts\/[0-9a-f-]{36}$/i);
    const draftId = draftIdFromUrl(page.url());

    await page.getByTestId("import-file-input").setInputFiles(
      addressImportFixture(suffix, planningDate),
    );
    await expect(page.getByRole("button", { name: /^(Nästa|Next)$/ })).toBeVisible();

    // Add and map one custom source column; the API assertion below proves it
    // survives the draft round-trip and the real stop import.
    await page
      .getByRole("button", { name: /custom field|eget fält/i })
      .click();
    const customNameInput = page.getByRole("textbox", {
      name: /Fältnamn|custom field name/i,
    });
    await customNameInput.fill(customFieldLabel);
    await page.getByRole("button", { name: /add field|lägg till/i }).click();
    const customRow = page.locator("tr").filter({ hasText: customFieldLabel });
    await customRow.getByRole("combobox").click();
    await page.getByRole("option", { name: customFieldLabel, exact: true }).click();

    await page.getByRole("button", { name: /^(Nästa|Next)$/ }).click();
    await page.getByRole("button", { name: /^(Nästa|Next)$/ }).click();

    const deliveryCandidate = page.getByTestId(
      `planning-draft-geocode-candidate-${deliveryCandidateId}`,
    );
    const pickupCandidate = page.getByTestId(
      `planning-draft-geocode-candidate-${pickupCandidateId}`,
    );
    await expect(deliveryCandidate).toBeVisible();
    await expect(pickupCandidate).toBeVisible();
    await expect(deliveryCandidate).toContainText(/Google Maps/i);
    await expect(deliveryCandidate).toContainText(/partial|delvis/i);
    await page.screenshot({
      path: testInfo.outputPath("before-selection.png"),
      fullPage: true,
    });
    expect(geocodeBatchCalls).toBe(1);

    // Selecting delivery must not implicitly resolve pickup. The debounced
    // PUT is the autosave under test, not a mocked draft response.
    const deliveryAutosave = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT"
        && response.url().endsWith(`/api/planning-drafts/${draftId}`)
        && response.request().postDataJSON()?.state?.mappedRows?.some(
          (row: any) => row.referenceNumber === `E2E-address-${suffix}-pickup`
            && row.latitude === deliveryLatitude && row.longitude === deliveryLongitude,
        ),
    );
    await deliveryCandidate.click();
    const deliveryAutosaveResponse = await deliveryAutosave;
    expect(deliveryAutosaveResponse.status()).toBe(200);
    const intermediateDraft = await deliveryAutosaveResponse.json();
    const intermediateRow = intermediateDraft.state.mappedRows.find(
      (row: any) => row.referenceNumber === `E2E-address-${suffix}-pickup`,
    );
    expect(intermediateRow).toMatchObject({
      address: "GIFFELVÄGEN 19",
      postalCode: "123 45",
      city: "Stockholm",
      pickupAddress: "KRYDDÅRDSVÄGEN 4",
      latitude: deliveryLatitude,
      longitude: deliveryLongitude,
      _pickupCandidates: [{
        id: pickupCandidateId,
        partial: true,
      }],
    });
    expect(intermediateRow._deliveryCandidates).toBeUndefined();
    await expect(page.getByTestId("planning-draft-save-stops")).toBeDisabled();
    await expect(pickupCandidate).toBeVisible();
    await page.screenshot({
      path: testInfo.outputPath("after-delivery-selection.png"),
      fullPage: true,
    });

    // Verify both a browser reload and reopening from the persisted draft list.
    await page.reload();
    await expect(
      page.getByTestId(`planning-draft-geocode-candidate-${pickupCandidateId}`),
    ).toBeVisible();
    await expect(
      page.getByTestId(`planning-draft-geocode-candidate-${deliveryCandidateId}`),
    ).toHaveCount(0);
    const reloadedDraft = await api(page, `/api/planning-drafts/${draftId}`);
    expect(reloadedDraft.status).toBe(200);
    const reloadedRow = reloadedDraft.body.state.mappedRows.find(
      (row: any) => row.referenceNumber === `E2E-address-${suffix}-pickup`,
    );
    expect(reloadedRow).toMatchObject({
      address: "GIFFELVÄGEN 19",
      postalCode: "123 45",
      city: "Stockholm",
      pickupAddress: "KRYDDÅRDSVÄGEN 4",
      latitude: deliveryLatitude,
      longitude: deliveryLongitude,
      _pickupCandidates: [{ id: pickupCandidateId, partial: true }],
    });
    await expect(
      page.getByTestId(`import-address-delivery-${reloadedRow._id}`),
    ).toHaveValue("GIFFELVÄGEN 19");
    await page.screenshot({
      path: testInfo.outputPath("after-reload.png"),
      fullPage: true,
    });
    await page.goto("/routes/create");
    await expect(page.getByTestId(`button-draft-resume-${draftId}`)).toBeVisible();
    await page.getByTestId(`button-draft-resume-${draftId}`).click();
    await expect(page).toHaveURL(new RegExp(`/routes/drafts/${draftId}$`));
    await expect(
      page.getByTestId(`planning-draft-geocode-candidate-${pickupCandidateId}`),
    ).toBeVisible();
    expect(geocodeBatchCalls).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath("after-intermediate-reopen.png"),
      fullPage: true,
    });

    const pickupAutosave = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT"
        && response.url().endsWith(`/api/planning-drafts/${draftId}`)
        && response.request().postDataJSON()?.state?.mappedRows?.some(
          (row: any) => row.referenceNumber === `E2E-address-${suffix}-pickup`
            && row.pickupLatitude === pickupLatitude && row.pickupLongitude === pickupLongitude,
        ),
    );
    await page.getByTestId(`planning-draft-geocode-candidate-${pickupCandidateId}`).click();
    const pickupAutosaveResponse = await pickupAutosave;
    expect(pickupAutosaveResponse.status()).toBe(200);
    await expect(page.getByTestId("planning-draft-save-stops")).toBeEnabled();
    const bothSelectedDraft = await pickupAutosaveResponse.json();
    const bothSelectedRow = bothSelectedDraft.state.mappedRows.find(
      (row: any) => row.referenceNumber === `E2E-address-${suffix}-pickup`,
    );
    expect(bothSelectedRow).toMatchObject({
      address: "GIFFELVÄGEN 19",
      postalCode: "123 45",
      city: "Stockholm",
      pickupAddress: "KRYDDÅRDSVÄGEN 4",
      latitude: deliveryLatitude,
      longitude: deliveryLongitude,
      pickupLatitude,
      pickupLongitude,
    });
    expect(bothSelectedRow._deliveryCandidates).toBeUndefined();
    expect(bothSelectedRow._pickupCandidates).toBeUndefined();
    expect(geocodeBatchCalls).toBe(1);
    await page.screenshot({
      path: testInfo.outputPath("after-both-selection.png"),
      fullPage: true,
    });

    // Reopen once more before importing. This proves both explicit selections,
    // rather than only the unresolved candidate, survive hydration.
    await page.reload();
    await expect(page.getByTestId("planning-draft-save-stops")).toBeEnabled();
    const preImportDraft = await api(page, `/api/planning-drafts/${draftId}`);
    expect(preImportDraft.status).toBe(200);
    const preImportRow = preImportDraft.body.state.mappedRows.find(
      (row: any) => row.referenceNumber === `E2E-address-${suffix}-pickup`,
    );
    expect(preImportRow).toMatchObject({
      address: "GIFFELVÄGEN 19",
      postalCode: "123 45",
      city: "Stockholm",
      pickupAddress: "KRYDDÅRDSVÄGEN 4",
      latitude: deliveryLatitude,
      longitude: deliveryLongitude,
      pickupLatitude,
      pickupLongitude,
    });
    expect(preImportRow._deliveryCandidates).toBeUndefined();
    expect(preImportRow._pickupCandidates).toBeUndefined();
    expect(geocodeBatchCalls).toBe(1);

    const importResponse = page.waitForResponse(
      (response) =>
        response.request().method() === "POST"
        && response.url().includes("/api/stops/import"),
    );
    const importedDraftAutosave = page.waitForResponse(
      (response) =>
        response.request().method() === "PUT"
        && response.url().endsWith(`/api/planning-drafts/${draftId}`)
        && response.request().postDataJSON()?.state?.step === 5,
    );
    await page.getByTestId("planning-draft-save-stops").click();
    const imported = await importResponse;
    expect(imported.status()).toBe(201);
    const importedDraftAutosaveResponse = await importedDraftAutosave;
    expect(importedDraftAutosaveResponse.status()).toBe(200);
    const importBody = await imported.json();
    expect(importBody.savedRowCount).toBe(2);
    expect(importBody.stops).toHaveLength(2);

    const request = await api(page, `/api/planning-drafts/${draftId}`);
    expect(request.status).toBe(200);
    expect(request.body.importedResult.stops).toHaveLength(2);
    await page.goto("/routes/create");
    await expect(page.getByTestId(`button-draft-resume-${draftId}`)).toBeVisible();
    await page.getByTestId(`button-draft-resume-${draftId}`).click();
    await expect(page).toHaveURL(new RegExp(`/routes/drafts/${draftId}$`));
    await expect(page.getByTestId("planning-draft-flow")).toHaveAttribute(
      "data-draft-id",
      draftId,
    );
    expect((await api(page, `/api/planning-drafts/${draftId}`)).body.state.step).toBe(5);

    const importedByRef = new Map(
      importBody.stops.map((stop: any) => [stop.externalRef, stop]),
    );
    const pickupStop = importedByRef.get(`E2E-address-${suffix}-pickup`);
    const deliveryStop = importedByRef.get(`E2E-address-${suffix}-delivery`);
    expect(pickupStop).toMatchObject({
      address: "GIFFELVÄGEN 19 123 45 Stockholm",
      pickupAddress: "KRYDDÅRDSVÄGEN 4",
      latitude: deliveryLatitude,
      longitude: deliveryLongitude,
      pickupLatitude,
      pickupLongitude,
      customFields: { [customFieldLabel]: "HANDLE-WITH-CARE" },
    });
    expect(deliveryStop).toMatchObject({
      address: "Normal delivery street 8 222 33 Stockholm",
      pickupAddress: null,
      latitude: 59.3297,
      longitude: 18.0689,
      customFields: { [customFieldLabel]: "DELIVERY-ONLY" },
    });

    // The response is from the real import path; independently read the
    // tenant's persisted rows so a successful UI response cannot mask a DB
    // write or a field being dropped during serialization.
    const persisted = await api(
      page,
      `/api/stops?organizationId=${fixture.organizationId}`,
    );
    expect(persisted.status).toBe(200);
    const persistedByRef = new Map(
      persisted.body
        .filter((stop: any) => importedByRef.has(stop.externalRef))
        .map((stop: any) => [stop.externalRef, stop]),
    );
    expect(persistedByRef.get(`E2E-address-${suffix}-pickup`)).toMatchObject(pickupStop);
    expect(persistedByRef.get(`E2E-address-${suffix}-delivery`)).toMatchObject(deliveryStop);
    expect(disallowedRequests).toEqual([]);
  }
});