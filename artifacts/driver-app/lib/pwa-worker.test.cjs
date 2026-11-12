const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");

function worker() {
  const events = new Map();
  const requests = [];
  const cache = new Map();
  const shell = new Response("prepared-static-shell");
  const context = {
    URL, Response, Promise,
    self: {
      location: { href: "https://example.test/driver-app/driver-sw.js" },
      addEventListener: (name, handler) => events.set(name, handler),
      clients: { claim: async () => {} },
    },
    caches: {
      open: async () => ({
        addAll: async urls => { requests.push(...urls); },
        match: async request => cache.get(request.url ?? request),
        put: async (request, response) => { cache.set(request.url, response); },
      }),
      match: async url => url === "https://example.test/driver-app/" ? shell : undefined,
      keys: async () => [],
      delete: async () => true,
    },
    fetch: async () => { throw new Error("offline"); },
  };
  vm.runInNewContext(fs.readFileSync(require.resolve("../public/driver-sw.js"), "utf8"), context);
  return { events, requests, cache };
}
test("cold navigation falls back to the prepared shell under the artifact scope", async () => {
  const fixture = worker();
  let response;
  fixture.events.get("fetch")({
    request: { url: "https://example.test/driver-app/proof/stop", method: "GET", mode: "navigate" },
    respondWith: value => { response = value; },
  });
  assert.equal(await (await response).text(), "prepared-static-shell");
});
test("private APIs, media, writes and external assets are never intercepted", () => {
  const fixture = worker();
  for (const [url, method] of [
    ["https://example.test/api/routes", "GET"],
    ["https://example.test/driver-app/api/stops", "GET"],
    ["https://example.test/driver-app/storage/photo.png", "GET"],
    ["https://example.test/api/storage/objects/private", "GET"],
    ["https://cdn.example.test/photo.png", "GET"],
    ["https://example.test/driver-app/_expo/static/js/app.js", "POST"],
  ]) {
    let intercepted = false;
    fixture.events.get("fetch")({ request: { url, method, mode: "cors" }, respondWith: () => { intercepted = true; } });
    assert.equal(intercepted, false, `${method} ${url}`);
  }
});
test("initial shell preparation contains public metadata, not private data", async () => {
  const fixture = worker();
  let preparation;
  fixture.events.get("install")({ waitUntil: task => { preparation = task; } });
  await preparation;
  assert.deepEqual(fixture.requests, [
    "https://example.test/driver-app/", "https://example.test/driver-app/driver.webmanifest",
    "https://example.test/driver-app/driver-icon.png",
  ]);
});
