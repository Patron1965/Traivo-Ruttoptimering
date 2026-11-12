import { expect, type Page, type Route } from "@playwright/test";
import { utils, write } from "xlsx";
import { login, test } from "./auth";

test.setTimeout(120_000);

async function loginAt(page: Page, path = "/dispatch"): Promise<void> {
  await login(
    page,
    path,
    path === "/dispatch" ? "dispatch-split" : "input-draft-name",
  );
}

async function expectNamedDraftEntry(page: Page): Promise<void> {
  await expect(page).toHaveURL(/\/routes\/create$/);
  await expect(page.getByTestId("input-draft-name")).toBeVisible();
}

type ImportFormat = "csv" | "xlsx";

function customerRows(count: number) {
  return Array.from({ length: count }, (_, index) => [
    `ORDER-${index + 1}`,
    `Kund ${index + 1}`,
    `Gatan ${index + 1}`,
    "59.3293",
    "18.0686",
  ]);
}

function customerFile(format: ImportFormat, includeMalformedRow: boolean) {
  const headers = ["Ordernummer", "Namn", "Adress", "Latitud", "Longitud"];
  const rows = customerRows(includeMalformedRow ? 246 : 247);

  if (format === "csv") {
    const records = rows.map((row) => row.join(";"));
    if (includeMalformedRow) records.push("ORDER-247;bara-två-kolumner");
    return {
      name: "kund-247.csv",
      mimeType: "text/csv",
      buffer: Buffer.from(
        `\uFEFF${headers.join(";")}\r\n${records.join("\r\n")}`,
        "utf8",
      ),
    };
  }

  const sheet = utils.aoa_to_sheet([headers, ...rows]);
  const workbook = utils.book_new();
  utils.book_append_sheet(workbook, sheet, "Kunder");
  return {
    name: "kund-247.xlsx",
    mimeType:
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(write(workbook, { type: "array", bookType: "xlsx" })),
  };
}

async function mockSuccessfulImport(
  route: Route,
  expectedCount: number,
): Promise<void> {
  const requestBody = route.request().postDataJSON() as {
    expectedRowCount: number;
    stops: Array<Record<string, unknown>>;
  };
  expect(requestBody.expectedRowCount).toBe(expectedCount);
  expect(requestBody.stops).toHaveLength(expectedCount);

  await route.fulfill({
    status: 201,
    contentType: "application/json",
    body: JSON.stringify({
      imported: expectedCount,
      receivedRowCount: expectedCount,
      savedRowCount: expectedCount,
      stops: requestBody.stops.map((stop, index) => ({
        ...stop,
        id: `e2e-import-stop-${index + 1}`,
      })),
      rowResults: requestBody.stops.map((stop, index) => ({
        sourceRowNumber: stop.sourceRowNumber,
        status: "saved",
        stopId: `e2e-import-stop-${index + 1}`,
      })),
    }),
  });
}

async function stubPlanningDraft(
  page: Page,
  format: ImportFormat,
): Promise<string> {
  const id = `e2e-import-entry-${format}-draft`;
  const draft = {
    id,
    organizationId: "e2e-import-entry-organization",
    name: "",
    startAt: "",
    state: { step: 1, source: "import" } as Record<string, unknown>,
    revision: 0,
    importedResult: null,
    planId: null,
    createdAt: "2030-04-01T08:00:00.000Z",
    updatedAt: "2030-04-01T08:00:00.000Z",
  };

  await page.route("**/api/planning-drafts", async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({ drafts: [] }),
      });
      return;
    }

    if (route.request().method() === "POST") {
      const body = route.request().postDataJSON() as {
        name: string;
        startAt: string;
        state: Record<string, unknown>;
      };
      expect(body.name).toBeTruthy();
      expect(body.startAt).toMatch(/^2030-04-15T/);
      expect(body.state.source).toBe("import");
      draft.name = body.name;
      draft.startAt = body.startAt;
      draft.state = body.state;
      await route.fulfill({
        status: 201,
        contentType: "application/json",
        body: JSON.stringify(draft),
      });
      return;
    }

    await route.continue();
  });

  await page.route(`**/api/planning-drafts/${id}`, async (route) => {
    if (route.request().method() === "GET") {
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(draft),
      });
      return;
    }

    if (route.request().method() === "PUT") {
      const body = route.request().postDataJSON() as {
        revision?: number;
        state?: Record<string, unknown>;
      };
      if (body.state) draft.state = body.state;
      draft.revision += 1;
      draft.updatedAt = new Date().toISOString();
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify(draft),
      });
      return;
    }

    await route.continue();
  });

  return id;
}

async function expectCount(
  page: Page,
  label: string,
  count: number,
): Promise<void> {
  // Keep stable selectors independent of the customer-facing counter labels.
  if (!(await page.getByTestId("import-count-inlästa").isVisible())) {
    await page.getByRole("button", { name: "Importstatistik", exact: true }).click();
  }
  const testIdLabel = label === "Åtgärd krävs" ? "Åtgärd"
    : label === "Överförda rader" ? "Skickade" : label;
  await expect(
    page.getByTestId(`import-count-${testIdLabel.toLocaleLowerCase("sv-SE")}`),
  ).toContainText(new RegExp(`^\\s*${count}\\s*${label}\\s*$`));
}

async function runCustomerImport(
  page: Page,
  format: ImportFormat,
  options: { rejected: number },
): Promise<void> {
  const ready = 247 - options.rejected;
  const draftId = await stubPlanningDraft(page, format);
  await loginAt(page, "/import");

  await expectNamedDraftEntry(page);
  await page.getByTestId("input-draft-name").fill(`Kundimport 247 ${format}`);
  await page.getByTestId("input-draft-date").fill("2030-04-15");
  await expect(page.getByTestId("button-draft-start-import")).toHaveCount(0);
  await expect(page.getByTestId("button-draft-start-manual")).toHaveCount(0);
  await expect(page.getByTestId("draft-existing-stops-map")).toHaveCount(0);
  await page.getByTestId("button-draft-continue").click();
  await expect(page.getByTestId("input-draft-name")).toHaveCount(0);
  await page.getByTestId("button-draft-start-manual").click();
  await expect(page.getByTestId("draft-existing-stops-map")).toBeVisible();
  await page.getByTestId("button-draft-back").click();
  await expect(page.getByTestId("input-draft-name")).toHaveValue(`Kundimport 247 ${format}`);
  await expect(page.getByTestId("input-draft-date")).toHaveValue("2030-04-15");
  await expect(page.getByTestId("draft-existing-stops-map")).toHaveCount(0);
  await page.getByTestId("button-draft-continue").click();
  await page.getByTestId("button-draft-start-import").click();
  await expect(page).toHaveURL(new RegExp(`/routes/drafts/${draftId}$`));

  await page
    .getByTestId("import-file-input")
    .setInputFiles(customerFile(format, options.rejected > 0));

  await expectCount(page, "Inlästa", 247);
  await page.getByRole("button", { name: /^(Nästa|Next)$/i }).click();

  await expectCount(page, "Validerade", ready);
  await expectCount(page, "Klara", ready);
  await expectCount(page, "Åtgärd krävs", 0);
  await expectCount(page, "Avvisade", options.rejected);

  if (options.rejected > 0) {
    await expect(
      page.getByText("Raden har 2 kolumner men rubrikraden har 5."),
    ).toBeVisible();
    const downloadPromise = page.waitForEvent("download");
    await page.getByTestId("export-rejected-import-rows").click();
    const download = await downloadPromise;
    expect(download.suggestedFilename()).toBe("avvisade-import-rader.csv");
    const contents = await (await download.createReadStream()).toArray();
    expect(Buffer.concat(contents).toString("utf8")).toContain(
      "Raden har 2 kolumner",
    );
  }

  await page.getByRole("button", { name: /^(Nästa|Next)$/i }).click();
  const saveStopsButton = page.getByRole("button", {
    name: /^(Spara stopp och skapa ruttförslag|Save stops and create route suggestions)$/i,
  });
  await expect(saveStopsButton).toBeEnabled();
  await page.route("**/api/stops/import", (route) =>
    mockSuccessfulImport(route, ready),
  );
  await saveStopsButton.click();

  await expectCount(page, "Överförda rader", ready);
  await expectCount(page, "Sparade", ready);
}

test("all import entry points redirect to named draft creation", async ({
  page,
}) => {
  await loginAt(page, "/import");
  await expectNamedDraftEntry(page);

  await page.goto("/dispatch?workflow=import");
  await expectNamedDraftEntry(page);

  await page.goto("/routes/create");
  await expect(page.locator('a[href="/import"]')).toHaveCount(0);
  const sidebarBuildRoute = page.locator('a[href="/routes/create"]').first();
  await expect(sidebarBuildRoute).toBeVisible();
  await sidebarBuildRoute.click();
  await expectNamedDraftEntry(page);

  await page.goto("/orders");
  await expect(page.getByTestId("orders-import-workflow")).toBeVisible();
  await page.getByTestId("orders-import-workflow").click();
  await expectNamedDraftEntry(page);

  await page.goto("/dispatch");
  await page.getByTestId("dispatch-extra-tools").locator("summary").click();
  await page.getByTestId("dispatch-import-orders").click();
  await expectNamedDraftEntry(page);
});

test("247 customer rows survive the CSV UI import with an exportable rejection", async ({
  page,
}) => {
  await runCustomerImport(page, "csv", { rejected: 1 });
});

test("247 customer rows survive the XLSX UI import", async ({ page }) => {
  await runCustomerImport(page, "xlsx", { rejected: 0 });
});
