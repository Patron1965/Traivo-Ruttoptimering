import test from "node:test";
import assert from "node:assert/strict";
import { connectionTarget, environmentStore } from "./connection-target";

const input = { platform: "ios", development: true, domain: "development.example",
  nativePreviewOrigin: "https://published.example" };
test("native development connects to the requested server with isolated storage", () => {
  for (const platform of ["ios", "android"]) {
    const target = connectionTarget({ ...input, platform });
    assert.equal(target.apiBaseUrl, "https://published.example/api");
    assert.ok(target.storagePrefix.includes("published.example"));
  }
});
test("web and production builds ignore the native preview override", () => {
  for (const variant of [{ platform: "web" }, { development: false }]) {
    const target = connectionTarget({ ...input, ...variant });
    assert.equal(target.apiBaseUrl, "https://development.example/api");
    assert.equal(target.storagePrefix, "");
  }
});
test("published web uses its own origin regardless of the build-time hostname", () => {
  for (const domain of [undefined, "deployment.example", "stale-preview.example"]) {
    assert.deepEqual(connectionTarget({
      ...input, platform: "web", development: false, domain,
    }), { apiBaseUrl: "/api", storagePrefix: "" });
  }
});
test("native production retains the configured API server", () => {
  for (const platform of ["ios", "android"]) {
    assert.equal(connectionTarget({ ...input, platform, development: false }).apiBaseUrl,
      "https://development.example/api");
  }
});
test("invalid origins fail instead of silently using another backend", () => {
  for (const origin of ["http://example.com", "https://example.com/api", "https://u:p@example.com", "https://example.com?token=x"]) {
    assert.throws(() => connectionTarget({ ...input, nativePreviewOrigin: origin }));
  }
});
test("switching servers never reuses or deletes another server's login, GPS or offline work", async () => {
  const values = new Map<string, string>();
  const store = { getItem: async (key: string) => values.get(key) ?? null,
    setItem: async (key: string, value: string) => { values.set(key, value); },
    removeItem: async (key: string) => { values.delete(key); } };
  const development = environmentStore(store, "");
  const published = environmentStore(store, connectionTarget(input).storagePrefix);
  for (const key of ["token", "offline-session", "gps-session", "stop-report-queue"]) {
    await development.setItem(key, "development-only");
    assert.equal(await published.getItem(key), null);
    await published.setItem(key, "published-only");
    assert.equal(await development.getItem(key), "development-only");
    assert.equal(await published.getItem(key), "published-only");
    await published.multiRemove([key]);
    assert.equal(await development.getItem(key), "development-only");
  }
});
