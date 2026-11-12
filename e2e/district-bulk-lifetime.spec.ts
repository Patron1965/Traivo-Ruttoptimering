import { expect } from "@playwright/test";
import { test, connectDistrictBrowser, districtRequest } from "./district-bulk-fixture";

// Runs with district-bulk.spec.ts in one worker. The shared helper must not
// clean up its account at the end of the first importing spec.
test("district fixture stays usable across spec files", async ({ page, district }) => {
  const blocked = await connectDistrictBrowser(page, district, "admin");
  const points = await districtRequest(page, `/api/district-plans/${district.planId}/points?limit=1000`);
  expect(points.status).toBe(200);
  expect(new Set(points.body.points.map((p: { id: string }) => p.id))).toEqual(new Set(district.pointIds));
  expect((await districtRequest(page, "/api/auth/me")).body.user.organizationId).toBe(district.admin.organizationId);
  expect(blocked).toEqual([]);
});
