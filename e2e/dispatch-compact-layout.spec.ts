import { expect, test } from "@playwright/test";

// Read-only layout evidence, not operational persistence or route-quality evidence.
test("compact Dispatch reserves the viewport for map and timeline", async ({ page }, info) => {
  await page.route("**/api/**", async intercepted => {
    const path = new URL(intercepted.request().url()).pathname;
    if (intercepted.request().method() !== "GET") {
      return intercepted.fulfill({ status: 403, json: { error: "Read-only layout fixture" } });
    }
    let body: unknown = [];
    if (path.endsWith("/auth/me")) body = {
      user: { id: "compact-user", name: "Layout fixture", role: "admin", organizationId: "compact-org" },
    };
    else if (path.includes("/organizations/")) body = { id: "compact-org", name: "Layout fixture" };
    else if (path.includes("capabilities")) body = { district: false };
    return intercepted.fulfill({ json: body });
  });
  for (const viewport of [{ width: 1512, height: 982 }, { width: 1024, height: 768 }]) {
    await page.setViewportSize(viewport);
    await page.goto("/dispatch");
    const overview = page.getByTestId("dispatch-plan-overview");
    await expect(overview).toBeVisible();
    await expect(overview).not.toHaveAttribute("open");
    const split = page.getByTestId("dispatch-split");
    await expect(split).toBeVisible();
    const bounds = await split.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.y).toBeLessThan(viewport.height * 0.4);
    expect(bounds!.height).toBeGreaterThan(viewport.height * 0.55);
    await overview.locator(":scope > summary").click();
    await expect(overview).toHaveAttribute("open", "");
    await expect(page.getByText("Underlag", { exact: true }).first()).toBeVisible();
    await overview.locator(":scope > summary").click();
    await expect(overview).not.toHaveAttribute("open");
    await page.screenshot({ path: info.outputPath(`compact-dispatch-${viewport.width}.png`) });
  }
});
