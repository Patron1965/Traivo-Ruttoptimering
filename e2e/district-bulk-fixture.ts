import { test as base, expect, type Page } from "@playwright/test";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { resolve } from "node:path";

export interface DistrictFixture {
  origin: string;
  controlKey: string;
  admin: { email: string; password: string; organizationId: string };
  viewer: { email: string; password: string };
  planId: string;
  zoneId: string;
  originals: Record<string, string>[];
  pointIds: string[];
  dataset: string;
}

// A declared worker fixture owns the process and schema from provisioning
// through teardown. Importing helpers never registers suite cleanup hooks.
export const test = base.extend<{}, { district: DistrictFixture }>({
  district: [async ({}, use) => {
    const require = createRequire(resolve("artifacts/api-server/package.json"));
    const child = spawn(process.execPath, ["--import", require.resolve("tsx"),
      resolve("artifacts/api-server/src/testing/district-e2e-harness.ts")], {
      env: { ...process.env, NODE_ENV: "test", PORT: "3000", RATE_LIMIT_MAX: "10000" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "", errors = "";
    child.stderr.on("data", data => { errors += String(data); });
    const exited = once(child, "exit");
    try {
      const fixture = await new Promise<DistrictFixture>((resolveReady, reject) => {
        const timeout = setTimeout(() => reject(new Error(`District harness timed out: ${errors}`)), 60_000);
        child.once("exit", code => {
          clearTimeout(timeout);
          reject(new Error(`District harness exited (${code}): ${errors}`));
        });
        child.stdout.on("data", data => {
          output += String(data);
          const match = output.match(/DISTRICT_E2E_READY (.+)\n/);
          if (match) {
            clearTimeout(timeout);
            resolveReady(JSON.parse(match[1]));
            output = "";
          }
        });
      });
      await use(fixture);
    } finally {
      if (child.pid && child.exitCode === null) child.kill("SIGTERM");
      const result = await Promise.race([
        exited,
        new Promise<never>((_, reject) => {
          const timeout = setTimeout(() => reject(new Error("District harness cleanup timed out; inspect its owned schema before retrying")), 30_000);
          timeout.unref();
        }),
      ]);
      expect(result[0], `District fixture teardown failed: ${errors}`).toBe(0);
    }
  }, { scope: "worker", timeout: 120_000 }],
});

test.use({ viewport: { width: 1440, height: 1000 } });

export async function connectDistrictBrowser(page: Page, fixture: DistrictFixture, role: "admin" | "viewer") {
  const blocked: string[] = [];
  await page.route("**/*", async route => {
    const url = new URL(route.request().url());
    const appOrigin = new URL(test.info().project.use.baseURL as string).origin;
    if (url.origin !== appOrigin) {
      // Map tiles are cosmetic and intentionally unavailable in this synthetic
      // test. Any geocoding/payment traffic is a test failure.
      if (!/tile\.openstreetmap\.org$/.test(url.hostname) &&
          !["fonts.googleapis.com", "fonts.gstatic.com"].includes(url.hostname)) {
        blocked.push(url.hostname + url.pathname);
      }
      await route.abort();
    } else if (url.pathname.startsWith("/api/")) {
      const response = await route.fetch({ url: fixture.origin + url.pathname + url.search });
      await route.fulfill({ response });
    } else await route.continue();
  });
  await page.goto(`/districts/${fixture.planId}`);
  await expect(page.locator("#email")).toBeVisible();
  await page.locator("#email").fill(fixture[role].email);
  await page.locator("#password").fill(fixture[role].password);
  await page.locator("#password").press("Enter");
  await expect(page.getByTestId("page-district-plan")).toBeVisible();
  return blocked;
}

// Fetch in the browser, not page.request: browser interception deliberately
// routes every API call to the fixture's real isolated API.
export async function districtRequest(page: Page, path: string, method = "GET", body?: unknown) {
  return page.evaluate(async ({ path, method, body }) => {
    const response = await fetch(path, { method, credentials: "include",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json().catch(() => null) };
  }, { path, method, body });
}

export function parseDistrictCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [], value = "", quoted = false;
  text = text.replace(/^\uFEFF/, "");
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      if (quoted && text[i + 1] === '"') { value += '"'; i++; }
      else quoted = !quoted;
    } else if (c === ";" && !quoted) { row.push(value); value = ""; }
    else if (c === "\n" && !quoted) {
      row.push(value.replace(/\r$/, "")); rows.push(row); row = []; value = "";
    } else value += c;
  }
  if (quoted) throw new Error("Unterminated CSV quote");
  if (value || row.length) { row.push(value); rows.push(row); }
  return rows;
}

export async function readDistrictDownload(page: Page, path: string, format: "csv" | "xlsx") {
  const bytes = await readFile(path);
  if (format === "csv") return parseDistrictCsv(bytes.toString("utf8"));
  // Reuse the server's installed ZIP dependency; no new package is required.
  const require = createRequire(resolve("artifacts/api-server/package.json"));
  const JSZip = require("jszip") as typeof import("../artifacts/api-server/node_modules/jszip");
  const zip = await JSZip.loadAsync(bytes);
  const xml = await zip.file("xl/worksheets/sheet1.xml")!.async("string");
  return page.evaluate(xml => {
    const doc = new DOMParser().parseFromString(xml, "application/xml");
    if (doc.querySelector("parsererror")) throw new Error("Invalid workbook XML");
    return Array.from(doc.querySelectorAll("sheetData > row"), row =>
      Array.from(row.querySelectorAll("c"), cell => cell.querySelector("t, v")?.textContent ?? ""));
  }, xml);
}
