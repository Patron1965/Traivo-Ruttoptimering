import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import { districtCapabilityAllowed, districtCapabilityKey } from "./district-capability.ts";

test("capability cache partitions both organization and user identity", () => {
  const a = districtCapabilityKey({ id: "a", organizationId: "org-a" });
  assert.notDeepEqual(a, districtCapabilityKey({ id: "a", organizationId: "org-b" }));
  assert.notDeepEqual(a, districtCapabilityKey({ id: "b", organizationId: "org-a" }));
  assert.notDeepEqual(a, districtCapabilityKey(null));
});
test("no missing, stale cached, failed or signed-out grant can open districts", () => {
  const granted = { isFetchedAfterMount: true, isError: false, data: { districtEnabled: true } };
  assert.equal(districtCapabilityAllowed(true, granted), true);
  assert.equal(districtCapabilityAllowed(false, granted), false);
  assert.equal(districtCapabilityAllowed(true, { ...granted, isFetchedAfterMount: false }), false);
  assert.equal(districtCapabilityAllowed(true, { ...granted, isError: true }), false);
  assert.equal(districtCapabilityAllowed(true, { ...granted, data: undefined }), false);
  assert.equal(districtCapabilityAllowed(true, { ...granted, data: { districtEnabled: false } }), false);
});
test("direct routes guard mounting the component that fetches district data and navigation is hidden", () => {
  const page = readFileSync(new URL("../pages/Districts.tsx", import.meta.url), "utf8");
  const wrapper = page.slice(page.indexOf("export default function Districts"), page.indexOf("function DistrictsContent"));
  assert.ok(wrapper.indexOf("if (!capability.allowed)") < wrapper.indexOf("<DistrictsContent"));
  assert.doesNotMatch(wrapper, /useDistrictPlans\(|useDistrictPlan\(|useDistrictPoints\(|intakeApi\./);
  const sidebar = readFileSync(new URL("../components/layout/Sidebar.tsx", import.meta.url), "utf8");
  assert.match(sidebar, /item.href === "\/districts" && !district.allowed/);
});
