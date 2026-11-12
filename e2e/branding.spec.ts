import { expect, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { authenticatedOrganizationId, login, test } from "./auth";

test.setTimeout(180_000);

const PNG_ONE = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAE0lEQVR4nGP4z8DwnwGM/zMwAAAf7gP9NRsAMwAAAAB5JRU5ErkJggg==",
  "base64",
);
const PNG_TWO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAD0lEQVR4nGNg+M8AQhAKABvyA/1tVLjHAAAAAElFTkSuQmCC",
  "base64",
);

type ApiResult<T = any> = {
  status: number;
  body: T;
};

type SeededFixture = {
  trackingCode: string;
  routeId: string;
  stopId: string;
  vehicleId: string;
};

let seededFixture: SeededFixture | undefined;

async function api<T = any>(
  page: Page,
  path: string,
  method = "GET",
  body?: unknown,
): Promise<ApiResult<T>> {
  const response = await page.request.fetch(path, {
    method,
    ...(body === undefined ? {} : { data: body }),
  });
  const text = await response.text();
  return {
    status: response.status(),
    body: text ? JSON.parse(text) : null,
  };
}

async function existingTrackingCode(
  page: Page,
  organizationId: string,
): Promise<string | null> {
  const result = await api<Array<{ trackingCode?: string | null }>>(
    page,
    `/api/stops?organizationId=${organizationId}`,
  );
  expect(result.status).toBe(200);
  return result.body.find((stop) => stop.trackingCode)?.trackingCode ?? null;
}

async function seedTrackingCode(
  page: Page,
  organizationId: string,
): Promise<SeededFixture> {
  const suffix = randomUUID().slice(0, 8);
  const vehicle = await api<{ id: string }>(page, "/api/vehicles", "POST", {
    organizationId,
    name: `E2E branding vehicle ${suffix}`,
    licensePlate: `BRD-${suffix}`,
    vehicleType: "fossil",
    capacityKg: 1_000,
    capacityVolume: 10,
    isActive: true,
  });
  expect(vehicle.status).toBe(201);

  const stop = await api<{ id: string }>(page, "/api/stops", "POST", {
    organizationId,
    address: `E2E branding tracking stop ${suffix}`,
    latitude: 59.3293,
    longitude: 18.0686,
    serviceDurationMin: 5,
    jobType: "delivery",
  });
  expect(stop.status).toBe(201);

  const optimized = await api<{ routes?: Array<{ routeId?: string }> }>(
    page,
    "/api/optimize",
    "POST",
    {
      organizationId,
      vehicleIds: [vehicle.body.id],
      stopIds: [stop.body.id],
      depotLatitude: 59.3293,
      depotLongitude: 18.0686,
      timeBudgetMs: 1_000,
    },
  );
  expect(optimized.status).toBe(200);
  const routeId = optimized.body.routes?.[0]?.routeId;
  expect(routeId).toBeTruthy();

  const stops = await api<Array<{ id: string; trackingCode?: string | null }>>(
    page,
    `/api/stops?organizationId=${organizationId}`,
  );
  expect(stops.status).toBe(200);
  const createdStop = stops.body.find(
    (candidate) => candidate.id === stop.body.id,
  );
  expect(createdStop?.trackingCode).toBeTruthy();

  const fixture = {
    trackingCode: createdStop!.trackingCode!,
    routeId: routeId!,
    stopId: stop.body.id,
    vehicleId: vehicle.body.id,
  };
  seededFixture = fixture;
  return fixture;
}

async function cssTheme(
  page: Page,
): Promise<{ primary: string; background: string }> {
  return page.evaluate(() => {
    const styles = getComputedStyle(document.documentElement);
    return {
      primary: styles.getPropertyValue("--primary").trim(),
      background: styles.getPropertyValue("--background").trim(),
    };
  });
}

async function inlineTheme(
  page: Page,
): Promise<{ primary: string; background: string }> {
  return page.evaluate(() => ({
    primary: document.documentElement.style
      .getPropertyValue("--primary")
      .trim(),
    background: document.documentElement.style
      .getPropertyValue("--background")
      .trim(),
  }));
}

function revision(url: string): string {
  return new URL(url, "http://branding.test").searchParams.get("v") ?? "";
}

test("branding draft, themes, sessions, tracking isolation, and real logo replacement", async ({
  page,
}) => {
  await login(page, "/dispatch", "dispatch-split");
  const organizationId = await authenticatedOrganizationId(page);

  // Start from the neutral profile so this acceptance flow is deterministic.
  const reset = await api(page, "/api/branding", "DELETE");
  expect(reset.status).toBe(200);
  await page.reload();
  await expect(page.getByTestId("dispatch-split")).toBeVisible();

  const trackingCode =
    (await existingTrackingCode(page, organizationId)) ??
    (await seedTrackingCode(page, organizationId)).trackingCode;

  // A signed-in session must not inject its authenticated theme into a
  // public tracking response that has no brand of its own.
  const trackingApi = await api<{ brand: unknown; trackingCode: string }>(
    page,
    `/api/track/${trackingCode}`,
  );
  expect(trackingApi.status).toBe(200);
  expect(trackingApi.body.trackingCode).toBe(trackingCode);
  expect(trackingApi.body.brand).toMatchObject({
    logoUrl: null,
    logoDarkUrl: null,
    primaryColor: null,
    accentColor: null,
    backgroundColor: null,
  });
  await page.goto(`/track/${trackingCode}`);
  await expect(page.getByText(trackingCode)).toBeVisible();
  await expect(
    page.getByText((trackingApi.body.brand as { name: string }).name, {
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.locator("header img")).toHaveCount(0);
  expect((await inlineTheme(page)).primary).toBe("");

  await page.goto("/settings");
  await page.getByRole("button", { name: "Kundanpassning" }).click();
  await expect(
    page.getByRole("heading", { name: "Kundanpassning" }),
  ).toBeVisible();

  const displayName = page.locator('input[placeholder="Ex. Företaget AB"]');
  const primaryColor = page.locator('input[placeholder="#3b82f6"]');
  const accentColor = page.locator('input[placeholder="#10b981"]');
  const backgroundColor = page.locator('input[placeholder="#ffffff"]');
  const websiteUrl = page
    .locator('input[placeholder="https://example.com"]')
    .first();
  const fileInputs = page.locator('input[type="file"]');

  await expect(displayName).toHaveValue("");
  await displayName.fill("Draft should be cancelled");
  await primaryColor.fill("#123456");
  await page.getByRole("button", { name: "Avbryt" }).click();
  await expect(displayName).toHaveValue("");
  expect((await api(page, "/api/branding")).body).toMatchObject({
    displayName: null,
    primaryColor: null,
    logoUrl: null,
    logoDarkUrl: null,
  });

  await displayName.fill("E2E Branding");
  await websiteUrl.fill("https://branding.example.test");
  await primaryColor.fill("#123456");
  await accentColor.fill("#abcdef");
  await backgroundColor.fill("#f8fafc");
  await expect(fileInputs).toHaveCount(2);
  await fileInputs.nth(0).setInputFiles({
    name: "branding-light.png",
    mimeType: "image/png",
    buffer: PNG_ONE,
  });
  await fileInputs.nth(1).setInputFiles({
    name: "branding-dark.png",
    mimeType: "image/png",
    buffer: PNG_TWO,
  });
  await expect(page.locator('img[alt="Logo"]').first()).toHaveAttribute(
    "src",
    /\/api\/branding\/logo\/preview\//,
  );
  await expect(page.locator('img[alt="Logo Dark"]')).toHaveAttribute(
    "src",
    /\/api\/branding\/logo\/preview\//,
  );
  await expect(page.locator('img[alt="Logo"]')).toHaveCount(2);
  await expect(page.locator('img[alt="Logo Dark"]')).toHaveCount(1);

  // Exercise both preview modes before publishing the profile.
  const previewSwitch = page.locator("#preview-mode");
  await expect(previewSwitch).toHaveAttribute("aria-checked", "false");
  await previewSwitch.click();
  await expect(page.getByText("Mörkt", { exact: true })).toBeVisible();
  await previewSwitch.click();
  await expect(page.getByText("Ljust", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: "Spara inställningar" }).click();
  await expect(
    page.getByText("Kundanpassning har sparats.", { exact: true }),
  ).toBeVisible();
  const firstBrand = await api<{
    displayName: string | null;
    primaryColor: string | null;
    accentColor: string | null;
    backgroundColor: string | null;
    websiteUrl: string | null;
    logoUrl: string | null;
    logoDarkUrl: string | null;
  }>(page, "/api/branding");
  expect(firstBrand.status).toBe(200);
  expect(firstBrand.body).toMatchObject({
    displayName: "E2E Branding",
    primaryColor: "#123456",
    accentColor: "#abcdef",
    backgroundColor: "#f8fafc",
    websiteUrl: "https://branding.example.test/",
  });
  expect(firstBrand.body.logoUrl).toMatch(
    new RegExp(
      `/api/branding/public/${organizationId}/light\\?v=[a-f0-9]{16}$`,
    ),
  );
  expect(firstBrand.body.logoDarkUrl).toMatch(
    new RegExp(`/api/branding/public/${organizationId}/dark\\?v=[a-f0-9]{16}$`),
  );

  // The saved colors must reach the application root in both global modes.
  const themeToggle = page.locator('header button[title*="Light" i]');
  if (await themeToggle.count()) await themeToggle.click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("light")),
    )
    .toBe(true);
  const lightTheme = await cssTheme(page);
  expect(lightTheme.primary).not.toBe("");
  expect(lightTheme.background).not.toBe("");

  await page.locator('header button[title*="Dark" i]').click();
  await expect
    .poll(() =>
      page.evaluate(() => document.documentElement.classList.contains("dark")),
    )
    .toBe(true);
  const darkTheme = await cssTheme(page);
  expect(darkTheme.primary).toBe(lightTheme.primary);
  expect(darkTheme.background).not.toBe(lightTheme.background);

  // Replacing through the real upload flow must publish a fresh revisioned PNG.
  await fileInputs.nth(0).setInputFiles({
    name: "branding-light-replacement.png",
    mimeType: "image/png",
    buffer: PNG_TWO,
  });
  await expect(page.locator('img[alt="Logo"]').first()).toHaveAttribute(
    "src",
    /\/api\/branding\/logo\/preview\//,
  );
  await expect(page.locator('img[alt="Logo"]')).toHaveCount(2);
  const saveButton = page.getByRole("button", { name: "Spara inställningar" });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect(
    page.getByText("Kundanpassning har sparats.", { exact: true }),
  ).toBeVisible();
  const secondBrand = await api<{ logoUrl: string | null }>(
    page,
    "/api/branding",
  );
  expect(secondBrand.body.logoUrl).toMatch(
    new RegExp(
      `/api/branding/public/${organizationId}/light\\?v=[a-f0-9]{16}$`,
    ),
  );
  expect(secondBrand.body.logoUrl).not.toBe(firstBrand.body.logoUrl);
  expect(revision(secondBrand.body.logoUrl!)).not.toBe(
    revision(firstBrand.body.logoUrl!),
  );
  const publicLogo = await page.request.get(secondBrand.body.logoUrl!);
  expect(publicLogo.status()).toBe(200);
  expect(publicLogo.headers()["content-type"]).toBe("image/png");
  expect((await publicLogo.body()).subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );

  // Logging out must clear the organization-scoped CSS and UI immediately.
  await page.getByRole("button", { name: /logga ut|log out/i }).click();
  await expect(page.locator("#email")).toBeVisible();
  await expect
    .poll(() => inlineTheme(page))
    .toEqual({ primary: "", background: "" });
  await expect(page.locator("aside")).toHaveCount(0);
});

test.afterEach(async ({ page }) => {
  // The acceptance test intentionally logs out. Re-authenticate only for
  // cleanup, then leave the shared E2E organization on the neutral profile.
  try {
    if ((await page.locator("#email").count()) > 0) {
      await login(page, "/dispatch", "dispatch-split");
    }
    const branding = await api(page, "/api/branding");
    if (branding.status === 200) await api(page, "/api/branding", "DELETE");
    if (seededFixture) {
      await api(page, `/api/routes/${seededFixture.routeId}`, "DELETE");
      await api(page, `/api/stops/${seededFixture.stopId}`, "DELETE");
      await api(page, `/api/vehicles/${seededFixture.vehicleId}`, "DELETE");
      seededFixture = undefined;
    }
  } catch {
    // Preserve the original failure; cleanup is best effort.
  }
});
