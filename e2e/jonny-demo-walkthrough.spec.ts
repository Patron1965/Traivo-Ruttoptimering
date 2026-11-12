import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";

test.skip(process.env.RUN_JONNY_DEMO !== "1", "Persistent demonstration is opt-in");
test("planner sends the isolated demo and driver opens the actual mobile app", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const demo = JSON.parse(readFileSync("/tmp/jonny-demo-provision.log", "utf8").trim().split("\n").at(-1)!);
  await page.goto(demo.plannerPath);
  await page.locator("#email").fill("planerare.jonny@example.test");
  await page.locator("#password").fill(process.env.TRAIVO_DEMO_PLANNER_PASSWORD!);
  await page.locator("#password").press("Enter");
  await expect(page.getByTestId("dispatch-split")).toBeVisible();
  await page.getByTestId("button-moment-godkann").click();
  await expect(page.getByTestId("dispatch-import-plan-approval")).toBeVisible();
  await page.screenshot({ path: info.outputPath("planner-review.png"), fullPage: true });
  const approve = page.getByTestId("planning-draft-approve");
  await expect(approve).toBeVisible();
  await approve.click();
  await expect(page.getByTestId("dispatch-import-plan-approved")).toBeVisible();
  const send = page.getByTestId(`planning-draft-send-${demo.routeId}`);
  await send.click();
  await expect.poll(async () => {
    const response = await page.request.get(`/api/routes/${demo.routeId}`);
    return (await response.json()).handoffDriverId;
  }).toBe(demo.driverId);
  await page.screenshot({ path: info.outputPath("planner-sent.png"), fullPage: true });
  const context = await browser.newContext({ viewport: { width: 402, height: 874 }, ignoreHTTPSErrors: true });
  try {
    const mobile = await context.newPage();
    await mobile.goto(`https://${process.env.REPLIT_EXPO_DEV_DOMAIN}/`);
    await mobile.getByPlaceholder(/namn@foretag.se|name@company.com/).fill("chauffor.jonny@example.test");
    await mobile.getByPlaceholder(/Ditt lösenord|Your password/).fill(process.env.TRAIVO_DEMO_DRIVER_PASSWORD!);
    await mobile.getByText(/^(Logga in|Sign in)$/).last().click();
    await expect(mobile.getByText(/Godkänn rutt|Accept route/, { exact: true })).toBeVisible({ timeout: 60000 });
    await mobile.getByText(/Godkänn rutt|Accept route/, { exact: true }).click();
    await mobile.getByText(/^(Bekräfta|Confirm)$/).last().click();
    await expect.poll(async () => {
      const response = await page.request.get(`/api/routes/${demo.routeId}`);
      return (await response.json()).handoffStatus;
    }).toBe("accepted");
    await mobile.screenshot({ path: info.outputPath("driver-accepted.png"), fullPage: true });
    await page.getByRole("dialog").getByRole("button", { name: /close|stäng/i }).click();
    await page.getByTestId("button-moment-utforande").click();
    await page.screenshot({ path: info.outputPath("planner-live.png"), fullPage: true });
  } finally { await context.close(); }
});

test("completion reaches the office without reloading", async ({ page, browser }, info) => {
  test.setTimeout(120_000);
  const demo = JSON.parse(readFileSync("/tmp/jonny-demo-provision.log", "utf8").trim().split("\n").at(-1)!);
  await page.goto(demo.plannerPath);
  await page.locator("#email").fill("planerare.jonny@example.test");
  await page.locator("#password").fill(process.env.TRAIVO_DEMO_PLANNER_PASSWORD!);
  await page.locator("#password").press("Enter");
  await page.getByTestId("button-moment-utforande").click();
  const stops = await (await page.request.get(`/api/routes/${demo.routeId}/stops`)).json();
  if (process.env.JONNY_VERIFY_EXISTING === "1") {
    const completed = stops.filter((s: any) => s.status === "completed");
    await expect(page.getByTestId("live-delivery-progress")).toContainText(`Utförda stopp: ${completed.length}/${stops.length}`);
    await page.getByText("Visa leveransstatus per stopp", { exact: true }).click();
    for (const stop of completed) {
      await expect(page.getByTestId(`execution-stop-${stop.id}`)).toContainText("Utfört");
    }
    await page.screenshot({ path: info.outputPath("office-completed-live.png"), fullPage: true });
    return;
  }
  const stop = stops.filter((s: any) => s.status === "pending").sort((a: any, b: any) => a.sequenceOrder - b.sequenceOrder)[0];
  expect(stop).toBeTruthy();
  const context = await browser.newContext({
    viewport: { width: 402, height: 874 }, ignoreHTTPSErrors: true,
    permissions: ["geolocation"], geolocation: { latitude: stop.latitude, longitude: stop.longitude, accuracy: 10 },
  });
  try {
    const mobile = await context.newPage();
    await mobile.goto(`https://${process.env.REPLIT_EXPO_DEV_DOMAIN}/`);
    await mobile.getByPlaceholder(/namn@foretag.se|name@company.com/).fill("chauffor.jonny@example.test");
    await mobile.getByPlaceholder(/Ditt lösenord|Your password/).fill(process.env.TRAIVO_DEMO_DRIVER_PASSWORD!);
    await mobile.getByText(/^(Logga in|Sign in)$/).last().click();
    await mobile.getByText(/^(Starta arbete|Start Work)$/).click();
    await mobile.getByTestId(`report-completed-${stop.id}`).click();
    await expect(mobile.getByTestId("save-stop-report")).toBeEnabled();
    await mobile.getByTestId("save-stop-report").click();
    await expect(mobile.getByText("Synkat med trafikledningen")).toBeVisible({ timeout: 30000 });
    await mobile.screenshot({ path: info.outputPath("driver-completed.png"), fullPage: true });
    await expect.poll(async () => {
      const result = await (await page.request.get(`/api/routes/${demo.routeId}/stops`)).json();
      return result.find((s: any) => s.id === stop.id).status;
    }).toBe("completed");
    await page.getByText("Visa leveransstatus per stopp", { exact: true }).click();
    await expect(page.getByTestId(`execution-stop-${stop.id}`)).toContainText("Utfört", { timeout: 15000 });
    await page.screenshot({ path: info.outputPath("office-completed-live.png"), fullPage: true });
  } finally { await context.close(); }
});
