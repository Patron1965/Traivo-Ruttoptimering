import { expect } from "@playwright/test";
import { randomUUID } from "node:crypto";
import { jsonApi, test } from "./dispatch-actual-fixture";

test.use({ timezoneId: "America/Los_Angeles", viewport: { width: 1440, height: 1000 } });
test.setTimeout(180_000);

for (const transport of ["realtime", "polling-after-429"] as const) {
  for (const report of [
    { type: "completed", label: "Genomfört" },
    { type: "failed", label: "Misslyckat" },
    { type: "skipped", label: "Överhoppat" },
  ] as const) {
  test(`new ${report.type} report updates actual time without changing the plan (${transport})`, async ({ page, actualFixture: f }, testInfo) => {
    let limited = false;
    let armLimit = false;
    let limitedAt = 0;
    const successfulReads: number[] = [];
    if (transport === "polling-after-429") {
      // Close the alternative freshness path: only real outgoing-view polling
      // can recover this case. No mocked success body or query invalidation.
      await page.routeWebSocket("**/*", socket => socket.close());
    }
    await page.route("**/api/routes/outgoing-view?*", async route => {
      if (armLimit && !limited) {
        limited = true;
        limitedAt = Date.now();
        await route.fulfill({ status: 429, headers: { "Retry-After": "2" }, json: { error: "Synthetic rate limit" } });
        return;
      }
      const response = await route.fetch();
      if (response.ok()) successfulReads.push(Date.now());
      await route.fulfill({ response });
    });
    await page.goto(`/dispatch?view=live&layout=timeline&planId=${f.planId}`);
    const row = page.locator(`[data-timeline-route-id="${f.routeId}"]`);
    await expect(row).toBeVisible();
    const blocks = row.getByTestId("dispatch-stop-block");
    await expect(blocks).toHaveCount(4);
    await expect(page.getByTestId(`actual-lane-${f.routeId}`)).toHaveCount(0);
    const geometry = () => blocks.evaluateAll(elements => elements.map(element => ({
      id: element.getAttribute("data-stop-id"),
      left: (element as HTMLElement).style.left,
      width: (element as HTMLElement).style.width,
    })));
    const beforeGeometry = await geometry();
    const routePath = `/api/routes/${f.routeId}`;
    const { body: beforeRoute } = await jsonApi(page.request, routePath);
    const planFields = (route: typeof beforeRoute) => ({
      date: route.date, planRevision: route.planRevision, plannerItinerary: route.plannerItinerary,
      workdayTimeline: route.workdayTimeline, workdaySummary: route.workdaySummary,
      totalDurationMin: route.totalDurationMin,
    });
    expect(beforeRoute.workdayTimeline.length).toBeGreaterThan(0);
    let navigations = 0;
    page.on("framenavigated", frame => { if (frame === page.mainFrame()) navigations++; });
    const documentId = randomUUID();
    await page.evaluate(id => { (window as any).__actualRegressionDocument = id; }, documentId);

      const stopId = f.stopIds[0];
      const event = {
        clientEventId: `actual-${stopId}-${report.type}`, type: report.type,
        planVersion: f.planVersion, occurredAt: new Date().toISOString(),
        ...(report.type === "skipped" ? { skipReason: "OTHER", comment: "Synthetic skip" } : {}),
      };
      armLimit = transport === "polling-after-429";
      const path = `/api/stops/${stopId}/execution-events`;
      const created = await jsonApi(page.request, path, "POST", event);
      expect(created.status).toBe(201);
      expect(created.body.event.clientEventId).toBe(event.clientEventId);
      const duplicate = await jsonApi(page.request, path, "POST", event);
      expect(duplicate.status).toBe(200);
      expect(duplicate.body.event.id).toBe(created.body.event.id);
      expect(created.body.event.occurredAt).toBe(event.occurredAt);
      const { body: stop } = await jsonApi(page.request, `/api/stops/${stopId}`);
      expect(stop.status).toBe(report.type);
      expect(Number.isFinite(Date.parse(stop.terminalAt))).toBe(true);
      // terminalAt is the server's committed transition time, not the client
      // event clock. Assert the real contract rather than changing production
      // retention/timestamp semantics to fit a historical test timestamp.
      const actualDate = new Date(stop.terminalAt);
      const time = actualDate.toLocaleTimeString("sv-SE", {
        timeZone: "Europe/Stockholm", hour: "2-digit", minute: "2-digit",
      });
      const day = new Intl.DateTimeFormat("sv-SE", {
        timeZone: "Europe/Stockholm", year: "numeric", month: "2-digit", day: "2-digit",
      }).format(actualDate);
      const otherDay = day !== beforeRoute.date.slice(0, 10);
      expect(otherDay).toBe(report.type === "skipped");
      if (transport === "polling-after-429") {
        await expect.poll(() => limited, { timeout: 20_000 }).toBe(true);
        await expect(page.getByText(/Liveuppdateringen är tillfälligt pausad/).first()).toBeVisible();
      }
      const hour = Number(time.slice(0, 2)) + Number(time.slice(3)) / 60;
      if (otherDay || hour < 6 || hour > 20) {
        await expect(page.getByTestId(`actual-mark-${stopId}`)).toHaveCount(0);
        const side = otherDay || hour > 20 ? "right" : "left";
        const edge = page.getByTestId(`actual-edge-${side}-${f.routeId}`);
        await expect(edge).toContainText(time, { timeout: 35_000 });
        await expect(edge).toHaveAttribute("aria-label", new RegExp(`${report.label} ${otherDay ? `${day} ` : ""}${time}`));
        await edge.click();
        await expect(page.getByTestId(`actual-edge-item-${stopId}`)).toContainText(`${report.label} ${otherDay ? `${day} ` : ""}${time}`);
        await page.keyboard.press("Escape");
      } else {
        const mark = page.getByTestId(`actual-mark-${stopId}`);
        await expect(mark).toBeVisible({ timeout: 35_000 });
        await expect(mark).toHaveCount(1);
        await expect(mark).toHaveAttribute("data-actual-kind", report.type);
        await expect(mark).toHaveAttribute("aria-label", new RegExp(`${report.label} ${time}.*Stockholm`));
      }
      expect((await jsonApi(page.request, `/api/stops/${stopId}`)).body.terminalAt).toBe(stop.terminalAt);
      expect(await geometry()).toEqual(beforeGeometry);
      expect(planFields((await jsonApi(page.request, routePath)).body)).toEqual(planFields(beforeRoute));
      expect(navigations).toBe(0);
      expect(await page.evaluate(() => (window as any).__actualRegressionDocument)).toBe(documentId);
    // The unreported stop must never acquire a fabricated actual time.
    await expect(page.getByTestId(`actual-mark-${f.stopIds[3]}`)).toHaveCount(0);
    if (transport === "polling-after-429") {
      expect(limited).toBe(true);
      expect(successfulReads.some(at => at >= limitedAt + 2000)).toBe(true);
      await expect(page.getByText(/Liveuppdateringen är tillfälligt pausad/)).toHaveCount(0);
    }
    await page.screenshot({ path: testInfo.outputPath(`${transport}.png`) });
  });
  }
}
