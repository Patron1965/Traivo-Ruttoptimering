import { expect, type Page } from "@playwright/test";

type ApiCall = (page: Page, path: string, method: "GET" | "PUT", body?: unknown) =>
  Promise<{ status: number; body: any }>;

/** Resource creation already owns its internal driver; configure, never duplicate it. */
export async function configureResourceDriver(api: ApiCall, page: Page, input: Record<string, unknown>) {
  const listed = await api(page, `/api/drivers?organizationId=${encodeURIComponent(String(input.organizationId))}`, "GET");
  expect(listed.status).toBe(200);
  expect(Array.isArray(listed.body)).toBe(true);
  const matches = listed.body.filter((driver: { vehicleId?: string }) => driver.vehicleId === input.vehicleId);
  expect(matches, "A new unified resource must own exactly one driver profile").toHaveLength(1);
  const updated = await api(page, `/api/drivers/${matches[0].id}`, "PUT", input);
  expect(updated.status, JSON.stringify(updated.body)).toBe(200);
  return updated;
}
