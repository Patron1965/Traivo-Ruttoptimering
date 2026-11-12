import test from "node:test";
import assert from "node:assert/strict";
import { loadScopedCategories, type CategoryCachePorts } from "./report-category-cache.ts";

const active = { id: "one", label: "Original", active: true };
function fixture() {
  let org = "a";
  const cache = new Map([["report_categories_a", [active]]]);
  const ports: CategoryCachePorts = {
    organizationId: () => { if (!org) throw Error("signed out"); return org; },
    fetch: async () => ({ categories: [active] }),
    read: async (key, age) => {
      assert.equal(age, 7 * 86400_000);
      return cache.get(key) ?? null;
    },
    write: async (key, value) => { cache.set(key, value); },
  };
  return { ports, cache, change: (value: string) => { org = value; } };
}
test("offline categories are isolated by organization", async () => {
  const f = fixture();
  assert.deepEqual(await loadScopedCategories(false, f.ports), [active]);
  f.change("b");
  assert.deepEqual(await loadScopedCategories(false, f.ports), []);
});
test("reconnection refreshes names and removes inactive choices without rewriting old choices", async () => {
  const f = fixture();
  const savedChoice = { ...active };
  f.ports.fetch = async () => ({ categories: [{ ...active, label: "Renamed", active: false }] });
  assert.deepEqual(await loadScopedCategories(true, f.ports), []);
  assert.deepEqual(await loadScopedCategories(false, f.ports), []);
  assert.equal(savedChoice.label, "Original");
});
for (const phase of ["fetch", "read", "write"] as const) {
  test(`account changes during ${phase} never return previous organization's categories`, async () => {
    const f = fixture();
    const original = f.ports[phase];
    if (phase === "fetch") f.ports.fetch = async () => { f.change("b"); return { categories: [active] }; };
    if (phase === "read") f.ports.read = async () => { f.change(""); return [active]; };
    if (phase === "write") f.ports.write = async () => { f.change("b"); };
    assert.ok(original);
    assert.deepEqual(await loadScopedCategories(phase !== "read", f.ports), []);
  });
}
test("network failure uses bounded cache; missing or failed storage returns no categories", async () => {
  const f = fixture();
  f.ports.fetch = async () => { throw Error("offline"); };
  assert.deepEqual(await loadScopedCategories(true, f.ports), [active]);
  f.ports.read = async () => { throw Error("storage unavailable"); };
  assert.deepEqual(await loadScopedCategories(true, f.ports), []);
});
