import { expect, test as baseTest, type Page } from "@playwright/test";
import { randomUUID } from "node:crypto";
import {
  cleanupDisposableAuthFixture,
  provisionDisposableAuthFixture,
  type DisposableAuthFixture,
} from "./planning-draft-fixture";

// Operational browser tests use their own tenant administrator, never the
// bootstrap platform administrator (whose login must complete MFA).
export let e2eEmail: string;
export let e2ePassword: string;
let fixture: DisposableAuthFixture | undefined;

export const test = baseTest.extend<{}, { disposableAuth: void }>({
  disposableAuth: [
    async ({}, use) => {
      fixture = await provisionDisposableAuthFixture(randomUUID());
      e2eEmail = fixture.email;
      e2ePassword = fixture.password;
      try {
        await use();
      } finally {
        if (fixture) await cleanupDisposableAuthFixture(fixture);
      }
    },
    { scope: "worker", auto: true },
  ],
});

export async function login(page: Page, path: string, readyTestId: string): Promise<void> {
  await page.goto(path);
  const emailField = page.locator("#email");
  // Auth hydration is asynchronous: an immediate isVisible() can observe
  // neither the sign-in form nor the protected page and skip login entirely.
  await expect(
    emailField.or(page.getByTestId(readyTestId)).first(),
  ).toBeVisible();
  if (await emailField.isVisible()) {
    await emailField.fill(e2eEmail);
    await page.locator("#password").fill(e2ePassword);
    await page.locator("#password").press("Enter");
  }
  await expect(page.getByTestId(readyTestId)).toBeVisible();
}

export async function authenticatedOrganizationId(page: Page): Promise<string> {
  const response = await page.evaluate(async () => {
    const result = await fetch("/api/auth/me", { credentials: "include" });
    return {
      status: result.status,
      body: await result.json().catch(() => null),
    };
  });
  expect(response.status).toBe(200);
  expect(response.body?.user?.organizationId).toBeTruthy();
  return response.body.user.organizationId as string;
}