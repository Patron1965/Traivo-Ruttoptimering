import { expect, test, type Locator, type Page } from "@playwright/test";

const email = process.env.E2E_EMAIL;
const password = process.env.E2E_PASSWORD;
const adminEmail = process.env.E2E_ADMIN_EMAIL;
const adminPassword = process.env.E2E_ADMIN_PASSWORD;

test.setTimeout(180_000);
test.skip(
  !email || !password,
  "Responsive E2E tests require E2E_EMAIL and E2E_PASSWORD",
);

async function loginAt(page: Page, path: string) {
  await page.goto(path);

  const emailField = page.locator("#email");
  if (await emailField.isVisible()) {
    await emailField.fill(email!);
    await page.locator("#password").fill(password!);
    await page.locator("#password").press("Enter");
  }

  await expect(page.locator("main h1").first()).toBeVisible();
}

async function expectNoDocumentOverflow(page: Page) {
  const dimensions = await page.evaluate(() => ({
    clientWidth: document.documentElement.clientWidth,
    scrollWidth: document.documentElement.scrollWidth,
  }));

  expect(
    dimensions.scrollWidth,
    `document overflowed by ${dimensions.scrollWidth - dimensions.clientWidth}px`,
  ).toBeLessThanOrEqual(dimensions.clientWidth + 1);
}

async function expectInside(inner: Locator, outer: Locator) {
  await expect(inner).toBeVisible();
  await expect(outer).toBeVisible();

  const [innerBox, outerBox] = await Promise.all([
    inner.boundingBox(),
    outer.boundingBox(),
  ]);

  expect(innerBox).not.toBeNull();
  expect(outerBox).not.toBeNull();
  expect(innerBox!.x).toBeGreaterThanOrEqual(outerBox!.x - 1);
  expect(innerBox!.y).toBeGreaterThanOrEqual(outerBox!.y - 1);
  expect(innerBox!.x + innerBox!.width).toBeLessThanOrEqual(
    outerBox!.x + outerBox!.width + 1,
  );
  expect(innerBox!.y + innerBox!.height).toBeLessThanOrEqual(
    outerBox!.y + outerBox!.height + 1,
  );
}

async function expectTouchTarget(locator: Locator) {
  const bounds = await locator.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.width).toBeGreaterThanOrEqual(44);
  expect(bounds!.height).toBeGreaterThanOrEqual(44);
}

test("route actions stay inside their cards across languages and effective zoom widths", async ({
  page,
}) => {
  await loginAt(page, "/routes");

  const effectiveWidths = [
    { label: "100%", width: 1440 },
    { label: "125%", width: 1152 },
    { label: "150%", width: 960 },
    { label: "200%", width: 720 },
    { label: "mobile", width: 320 },
  ];

  for (const language of ["sv", "en"]) {
    await page.evaluate((lng) => localStorage.setItem("routeai-lang", lng), language);
    await page.reload();
    await expect(page.locator("main h1").first()).toBeVisible();

    for (const viewport of effectiveWidths) {
      await test.step(`${language} at ${viewport.label} (${viewport.width}px)`, async () => {
        await page.setViewportSize({ width: viewport.width, height: 900 });

        const planCard = page.getByTestId("route-plan-card").first();
        await expect(planCard).toBeVisible();
        const routeRows = planCard.getByTestId("route-card");
        if (!(await routeRows.first().isVisible())) {
          await planCard.getByRole("button", {
            name: /visa fordon|show vehicles|dölj fordon|hide vehicles/i,
          }).click();
        }
        await expect(routeRows.first()).toBeVisible();
        const card = routeRows.first();
        await planCard.locator("h3").first().evaluate((heading) => {
          heading.textContent =
            "En mycket lång ruttnamnsetikett för känslig sjukvårdsdistribution och fältservice";
        });

        const actions = card.getByTestId("route-card-actions");
        await expectInside(actions, card);

        const exportAction = actions.locator('a[download][href*="/export"]');
        const deleteAction = actions.locator("button[aria-label]").last();
        await expectTouchTarget(exportAction);
        await expectTouchTarget(deleteAction);
        await expectNoDocumentOverflow(page);
      });
    }
  }
});

test("table action columns remain visible and keyboard-labelled on narrow screens", async ({
  page,
}) => {
  await loginAt(page, "/stops");

  for (const width of [720, 320]) {
    await page.setViewportSize({ width, height: 900 });

    for (const path of ["/stops", "/drivers", "/vehicles"]) {
      await test.step(`${path} at ${width}px`, async () => {
        await page.goto(path);
        const table = page.locator("main table").first();
        await expect(table).toBeVisible();

        const actionHeader = table.locator("thead th").last();
        await expect(actionHeader).toBeVisible();
        const scroller = table.locator("xpath=..");
        const canScroll = await scroller.evaluate(
          (element) => element.scrollWidth > element.clientWidth + 1,
        );
        if (canScroll) {
          await scroller.evaluate((element) => {
            element.scrollLeft = element.scrollWidth;
          });
          await expect
            .poll(() => scroller.evaluate((element) => element.scrollLeft))
            .toBeGreaterThan(0);
        }

        const headerBox = await actionHeader.boundingBox();
        expect(headerBox).not.toBeNull();
        expect(headerBox!.x).toBeGreaterThanOrEqual(0);
        expect(headerBox!.x + headerBox!.width).toBeLessThanOrEqual(width + 1);

        const firstRow = table.locator("tbody tr").first();
        const firstActionCell = firstRow.locator("td").last();
        await expect(firstActionCell).toBeVisible();
        await firstRow.hover();
        await expect
          .poll(() => firstRow.evaluate((element) => element.matches(":hover")))
          .toBe(true);
        await expect(firstRow).toHaveClass(/group/);
        await expect(firstActionCell).toHaveClass(/group-hover:bg-muted/);

        const labelledActions = firstActionCell.locator(
          "button[aria-label], a[aria-label]",
        );
        expect(await labelledActions.count()).toBeGreaterThan(0);
        await expectTouchTarget(labelledActions.first());

        await firstRow.dispatchEvent("click");
        await page.mouse.move(width - 1, 899);
        await expect(firstActionCell).toHaveClass(/bg-blue-50/);
        await expectNoDocumentOverflow(page);
      });
    }
  }
});

test("admin user actions stay pinned when the admin E2E account is configured", async ({
  page,
}) => {
  test.skip(
    !adminEmail || !adminPassword,
    "E2E_ADMIN_EMAIL and E2E_ADMIN_PASSWORD are required for the admin-only Users page",
  );

  await page.goto("/users");
  await page.locator("#email").fill(adminEmail!);
  await page.locator("#password").fill(adminPassword!);
  await page.locator("#password").press("Enter");
  await page.setViewportSize({ width: 320, height: 900 });

  const table = page.locator("main table").first();
  await expect(table).toBeVisible();
  const scroller = table.locator("xpath=..");
  await scroller.evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });

  const actionHeader = table.locator("thead th").last();
  const firstActionCell = table.locator("tbody tr").first().locator("td").last();
  await expect(actionHeader).toBeVisible();
  await expect(firstActionCell).toBeVisible();
  await firstActionCell.locator("button").first().hover();
  await expectTouchTarget(firstActionCell.locator("button[aria-label]").first());
  await expectNoDocumentOverflow(page);
});

test("dispatch toolbar and dialogs remain inside the viewport", async ({ page }) => {
  await loginAt(page, "/dispatch");

  for (const width of [1024, 720, 320]) {
    await test.step(`dispatch toolbar at ${width}px`, async () => {
      await page.setViewportSize({ width, height: 900 });
      const toolbar = page.getByTestId("dispatch-action-toolbar");
      await expect(toolbar).toBeVisible();

      const viewportViolations = await toolbar.locator(":scope > *").evaluateAll(
        (items) =>
          items
            .map((item) => {
              const bounds = item.getBoundingClientRect();
              return {
                left: bounds.left,
                right: bounds.right,
                viewportWidth: document.documentElement.clientWidth,
              };
            })
            .filter(
              ({ left, right, viewportWidth }) =>
                left < -1 || right > viewportWidth + 1,
            ),
      );
      expect(viewportViolations).toEqual([]);
      await expectNoDocumentOverflow(page);
    });
  }

  await page.setViewportSize({ width: 320, height: 560 });
  for (const language of [
    { code: "sv", open: /lägg till förare/i, close: /stäng/i },
    { code: "en", open: /add driver/i, close: /close/i },
  ]) {
    await page.evaluate(
      (lng) => localStorage.setItem("routeai-lang", lng),
      language.code,
    );
    await page.goto("/drivers");
    await page.getByRole("button", { name: language.open }).click();

    const dialog = page.getByRole("dialog");
    await expect(dialog).toBeVisible();
    await expect
      .poll(async () => (await dialog.boundingBox())?.x ?? -1)
      .toBeGreaterThanOrEqual(15);
    const dialogBox = await dialog.boundingBox();
    expect(dialogBox).not.toBeNull();
    expect(dialogBox!.x).toBeGreaterThanOrEqual(15);
    expect(dialogBox!.y).toBeGreaterThanOrEqual(15);
    expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(305);
    expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(545);

    const closeButton = dialog.getByRole("button", { name: language.close });
    await expectTouchTarget(closeButton);
    await closeButton.click();
    await expect(dialog).toBeHidden();
    await expectNoDocumentOverflow(page);
  }
});