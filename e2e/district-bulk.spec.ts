import { expect, type Page } from "@playwright/test";
import { test, connectDistrictBrowser, districtRequest, readDistrictDownload,
  type DistrictFixture } from "./district-bulk-fixture";

test.setTimeout(180_000);

async function selectZone(page: Page) {
  await page.getByTestId("tab-optimize").click();
  await page.getByTestId("select-opt-zone").click();
  await page.getByRole("option", { name: /Syntetisk zon/ }).click();
}

async function pickExternalStart(page: Page, x = 0.85) {
  await page.getByTestId("button-pick-start").click();
  const map = page.getByTestId("district-map-region").locator(".leaflet-container");
  const box = await map.boundingBox();
  if (!box) throw new Error("District map has no layout");
  // Away from source markers and Leaflet controls; no address search.
  await map.click({ position: { x: box.width * x, y: box.height * 0.8 } });
  await expect(page.getByTestId("button-pick-start")).toHaveText("Välj på karta");
}

async function previewAndConfirm(page: Page, fixture: DistrictFixture) {
  const response = page.waitForResponse(r => r.url().endsWith("/bulk-preview") && r.request().method() === "POST");
  await page.getByTestId("button-bulk-preview").click();
  const checked = await response;
  expect(checked.status()).toBe(200);
  const body = await checked.json();
  expect(body.ready).toBe(true);
  expect([body.sourceCount, body.positionedCount, body.unresolvedCount]).toEqual([801, 800, 1]);
  expect(body.datasetIdentity).toBe(fixture.dataset);
  await expect(page.getByTestId("button-start-job")).toBeDisabled();
  await page.getByTestId("checkbox-bulk-warnings").check();
  await expect(page.getByTestId("button-start-job")).toBeEnabled();
  return body;
}

function assertConservedRows(rows: string[][], fixture: DistrictFixture) {
  const [headers, ...data] = rows;
  expect(data).toHaveLength(fixture.originals.length);
  const index = (name: string) => {
    const i = headers.indexOf(name);
    expect(i, `Missing column ${name}`).toBeGreaterThanOrEqual(0);
    return i;
  };
  const objectColumn = index("Object");
  const byObject = new Map(data.map(row => [row[objectColumn], row]));
  expect(byObject.size).toBe(801); // No co-located merging or duplicate rows.
  for (const original of fixture.originals) {
    const row = byObject.get(original.Object);
    expect(row, `Missing original object ${original.Object}`).toBeTruthy();
    for (const [column, value] of Object.entries(original)) expect(row![index(column)]).toBe(value);
    expect(row![index("Vägdataversion")]).toBe(fixture.dataset);
  }
  const unresolved = byObject.get(fixture.originals.at(-1)!.Object)!;
  expect(unresolved[index("Källstatus")]).toBe("unresolved");
  expect(unresolved[index("Positionsvarning")]).toBe("Position saknas");
  // Metadata columns are intentionally checked separately from source values.
  const routeColumn = headers.findIndex(h => /ruttordning/i.test(h));
  expect(routeColumn).toBeGreaterThanOrEqual(0);
  expect(unresolved[routeColumn]).toBe("0");
  expect(data.filter(row => row[routeColumn] !== "0")).toHaveLength(800);
}

test("whole-dataset bulk job: preflight, cancellation, reload, lossless CSV/XLSX and viewer authorization", async ({ page, browser, district }) => {
  const blocked = await connectDistrictBrowser(page, district, "admin");
  const root = `/api/district-plans/${district.planId}`;
  const before = await districtRequest(page, `${root}/points?limit=1000`);
  expect(before.status).toBe(200);
  expect(before.body.points).toHaveLength(800);
  expect(before.body.points.some((p: { zoneId: string | null }) => p.zoneId === null)).toBe(true);
  expect(before.body.points[0].id).not.toBe(before.body.points[1].id);
  const coordinates = before.body.points.map((p: { latitude: number; longitude: number }) => `${p.latitude},${p.longitude}`);
  expect(new Set(coordinates).size).toBe(799);
  await selectZone(page);
  await page.getByTestId("select-bulk-scope").selectOption("plan");
  await expect(page.getByTestId("button-start-job")).toBeDisabled();
  await pickExternalStart(page);
  await expect(page.getByTestId("button-start-job")).toBeDisabled();
  const firstPreview = await previewAndConfirm(page, district);
  const jobsPath = `${root}/zones/${district.zoneId}/jobs`;
  // The UI and API must both enforce proof; disabling a button alone isn't enough.
  expect((await districtRequest(page, jobsPath, "POST", {
    expectedRevision: 0, mode: "open", bulkScope: "plan",
    start: { latitude: 57.7, longitude: 11.97 }, serviceMinutes: 0,
  })).status).toBe(409);
  await pickExternalStart(page, 0.7);
  await expect(page.getByTestId("button-start-job")).toBeDisabled();
  await expect(page.getByTestId("checkbox-bulk-warnings")).toHaveCount(0);
  expect((await districtRequest(page, jobsPath, "POST", {
    expectedRevision: 0, mode: "open", bulkScope: "plan",
    start: { latitude: 57.7, longitude: 11.97 }, serviceMinutes: 0,
    bulkPreviewHash: firstPreview.previewHash,
  })).status).toBe(409);
  await previewAndConfirm(page, district);
  const control = `${district.origin}/__e2e/${district.controlKey}`;
  expect((await fetch(`${control}/hold`, { method: "POST" })).ok).toBe(true);
  const startResponse = page.waitForResponse(r => r.url().endsWith("/jobs") && r.request().method() === "POST");
  await page.getByTestId("button-start-job").click();
  const started = await startResponse;
  expect(started.status()).toBe(201);
  const cancelledId = (await started.json()).id;
  await expect(page.getByTestId("button-cancel-job")).toBeVisible();
  await expect.poll(async () =>
    (await districtRequest(page, `${root}/jobs/${cancelledId}`)).body.job.status,
  ).toBe("running");
  await page.getByTestId("button-cancel-job").click();
  await expect(page.getByTestId("status-job")).toContainText("Optimeringen avbröts");
  expect((await fetch(`${control}/release`, { method: "POST" })).ok).toBe(true);
  const cancelled = await districtRequest(page, `${root}/jobs/${cancelledId}`);
  expect(cancelled.body.job.status).toBe("cancelled");
  expect(cancelled.body.job.result).toBeUndefined();

  const nextResponse = page.waitForResponse(r => r.url().endsWith("/jobs") && r.request().method() === "POST");
  await page.getByTestId("button-start-job").click();
  const next = await nextResponse;
  expect(next.status()).toBe(201);
  const jobId = (await next.json()).id;
  await expect(page.getByTestId("panel-result")).toBeVisible({ timeout: 90_000 });
  await expect(page.getByTestId("text-result-stops")).toHaveText("800");
  const completed = await districtRequest(page, `${root}/jobs/${jobId}`);
  expect(new Set(completed.body.job.result.orderedPointIds)).toEqual(new Set(district.pointIds));
  await page.reload();
  await expect(page.getByTestId("page-district-plan")).toBeVisible();
  await selectZone(page);
  await expect(page.getByTestId("panel-result")).toBeVisible();
  await expect(page.getByTestId("text-result-stops")).toHaveText("800");
  expect((await districtRequest(page, `${root}/jobs/${jobId}`)).body.job.result).toEqual(completed.body.job.result);

  for (const format of ["csv", "xlsx"] as const) {
    await page.getByTestId("button-range-all").click();
    await expect(page.getByTestId("text-range-summary")).toContainText("800 stopp valda");
    await page.getByTestId("button-open-export").click();
    await page.getByTestId(`button-format-${format}`).click();
    // No column selection: bulk "Hela" must union ALL original columns,
    // including the column that exists only on the unresolved row.
    const confirm = page.getByTestId("checkbox-confirm-reexport");
    if (await confirm.count()) await confirm.check();
    const download = page.waitForEvent("download");
    await page.getByTestId("button-create-export").click();
    const file = await download;
    expect(file.suggestedFilename()).toMatch(new RegExp(`\\.${format}$`));
    expect(await file.failure()).toBeNull();
    const path = await file.path();
    expect(path).toBeTruthy();
    assertConservedRows(await readDistrictDownload(page, path!, format), district);
    await expect(page.getByRole("dialog")).toHaveCount(0);
  }
  const after = await districtRequest(page, `${root}/points?limit=1000`);
  // Export flags are intentionally mutable; source identity and values are not.
  const sourceOnly = (points: Record<string, unknown>[]) => points.map(({ exported, ...source }) => source);
  expect(sourceOnly(after.body.points)).toEqual(sourceOnly(before.body.points));
  expect(blocked).toEqual([]);
  const evidence = await (await fetch(`${control}/evidence`)).json();
  expect(evidence.providerCalls).toBeGreaterThan(0);
  expect(evidence.blockedExternalCalls).toBe(0);
  const viewerContext = await browser.newContext({
    baseURL: test.info().project.use.baseURL,
  });
  try {
    const viewerPage = await viewerContext.newPage();
    await assertViewerAccess(viewerPage, district);
  } finally { await viewerContext.close(); }
});

async function assertViewerAccess(page: Page, district: DistrictFixture) {
  const blocked = await connectDistrictBrowser(page, district, "viewer");
  const root = `/api/district-plans/${district.planId}`;
  const detail = await districtRequest(page, root);
  expect(detail.status).toBe(200);
  const jobs = detail.body.jobs;
  const completed = jobs.find((job: { status: string }) => job.status === "completed");
  expect(completed).toBeTruthy();
  await selectZone(page);
  await expect(page.getByTestId("button-start-job")).toHaveCount(0);
  await expect(page.getByTestId("button-open-export")).toHaveCount(0);
  const input = { expectedRevision: 0, mode: "open", bulkScope: "plan",
    start: { latitude: 57.708, longitude: 11.974 }, serviceMinutes: 0 };
  for (const suffix of ["bulk-preview", "jobs"]) {
    expect((await districtRequest(page, `${root}/zones/${district.zoneId}/${suffix}`, "POST", input)).status).toBe(403);
  }
  expect((await districtRequest(page, `${root}/intake`)).status).toBe(403);
  const points = await districtRequest(page, `${root}/points?limit=1000`);
  expect(JSON.stringify(points.body)).not.toContain("CustomerOnly");
  expect(JSON.stringify(points.body)).not.toContain("Bevara även denna kolumn");
  const history = await districtRequest(page, `${root}/exports`);
  expect(history.status).toBe(200);
  expect(history.body.exports.length).toBeGreaterThan(0);
  const exportId = history.body.exports[0].id;
  await page.getByTestId("tab-exports").click();
  await expect(page.locator('[data-testid^="button-download-"]')).toHaveCount(0);
  for (const format of ["csv", "xlsx"]) {
    expect((await districtRequest(page, `${root}/exports/${exportId}/file?format=${format}`)).status).toBe(403);
  }
  expect((await districtRequest(page, `${root}/jobs/${completed.id}/exports`, "POST", {
    pointIds: district.pointIds, columns: [], confirmReexport: true,
  })).status).toBe(403);
  expect(blocked).toEqual([]);
}
