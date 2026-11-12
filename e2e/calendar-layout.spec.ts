import { expect } from "@playwright/test";
import { login, test } from "./auth";

for (const language of ["sv", "en"]) {
  for (const width of [1280, 320]) {
    test(`calendar proportions and controls: ${language}, ${width}px`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript((lang) => localStorage.setItem("routeai-lang", lang), language);
      await login(page, "/routes/create", "input-draft-date");
      const input = page.getByTestId("input-draft-date");
      await input.fill("2026-09-13");
      await input.press("Escape");
      await input.click();
      const calendar = page.locator('[data-slot="calendar"]');
      await expect(calendar).toBeVisible();
      await expect(calendar.locator(".rdp-caption_label")).toHaveText(/september 2026/i);
      const geometry = await calendar.evaluate((root) => {
        const rect = (selector: string) => root.querySelector(selector)!.getBoundingClientRect();
        const caption = rect(".rdp-caption_label");
        const previous = rect(".rdp-button_previous");
        const next = rect(".rdp-button_next");
        const headers = [...root.querySelectorAll(".rdp-weekday")].map(el => el.getBoundingClientRect());
        const cells = [...root.querySelectorAll(".rdp-week:first-child .rdp-day")].map(el => el.getBoundingClientRect());
        const buttons = [...root.querySelectorAll(".rdp-day_button")].map(el => el.getBoundingClientRect());
        const bounds = root.getBoundingClientRect();
        return {
          clearCaption: caption.left >= previous.right && caption.right <= next.left,
          equalArrows: Math.abs(previous.width - next.width) < 1 && Math.abs(previous.height - next.height) < 1,
          aligned: headers.length === 7 && cells.every((cell, i) => Math.abs(cell.x - headers[i].x) < 1 && Math.abs(cell.width - headers[i].width) < 1),
          equalButtons: buttons.every(button => Math.abs(button.width - buttons[0].width) < 1 && Math.abs(button.height - buttons[0].height) < 1),
          fits: bounds.left >= 0 && bounds.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth,
        };
      });
      expect(geometry).toEqual({ clearCaption: true, equalArrows: true, aligned: true, equalButtons: true, fits: true });
      const selected = calendar.locator('[data-selected-single="true"]');
      await selected.focus();
      await selected.press("ArrowRight");
      await expect(calendar.locator(".rdp-day_button:focus")).toHaveText("14");
      await page.keyboard.press("Enter");
      await expect(input).toHaveValue("2026-09-14");
      await page.screenshot({ path: `screenshots/calendar-${language}-${width}.png` });
      await calendar.locator(".rdp-button_next").click();
      await expect(calendar.locator(".rdp-caption_label")).toHaveText(language === "sv" ? "oktober 2026" : "October 2026");
      await calendar.locator(".rdp-button_previous").click();
      await expect(calendar.locator(".rdp-caption_label")).toHaveText(/september 2026/i);
      await calendar.locator('.rdp-day:not(.rdp-outside) .rdp-day_button').filter({ hasText: /^22$/ }).click();
      await expect(input).toHaveValue("2026-09-22");
    });
  }
}