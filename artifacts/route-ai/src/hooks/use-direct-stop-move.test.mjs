import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import vm from "node:vm";
import ts from "typescript";

const source = ts.transpileModule(
  readFileSync(new URL("./use-direct-stop-move.ts", import.meta.url), "utf8"),
  { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } },
).outputText;

function harness() {
  const values = new Map();
  const browser = new EventTarget();
  let readError = false;
  let writeError = false;
  browser.localStorage = {
    getItem(key) {
      if (readError) throw new Error("Storage unavailable");
      return values.get(key) ?? null;
    },
    setItem(key, value) {
      if (writeError) throw new Error("Storage unavailable");
      values.set(key, value);
    },
  };
  const auth = { user: { id: "user-a", organizationId: "org-a" }, isLoading: false, isLoggingOut: false };
  const stores = [];
  const exports = {};
  vm.runInNewContext(source, {
    exports,
    window: browser,
    Event,
    require(name) {
      if (name === "@/lib/auth-context") return { useAuth: () => auth };
      if (name === "react") return {
        useCallback: (callback) => callback,
        useSyncExternalStore(subscribe, snapshot, serverSnapshot) {
          const store = { snapshot, serverSnapshot, notifications: 0 };
          store.unsubscribe = subscribe(() => { store.notifications += 1; });
          stores.push(store);
          return snapshot();
        },
      };
      throw new Error(`Unexpected dependency: ${name}`);
    },
  });
  return {
    auth, values, browser, stores,
    render: () => exports.useDirectStopMove(),
    errors(read, write) { readError = read; writeError = write; },
    storage(key, storageArea = browser.localStorage) {
      const event = new Event("storage");
      Object.assign(event, { key, storageArea });
      browser.dispatchEvent(event);
    },
  };
}

test("defaults off and accepts only an explicit opt-in; persists and notifies same-tab consumers", () => {
  const h = harness();
  const first = h.render();
  h.render();
  assert.equal(first.enabled, false);
  assert.equal(first.setEnabled(true), true);
  assert.equal(h.stores[0].snapshot(), true);
  assert.equal(h.stores[1].snapshot(), true);
  assert.equal(h.stores[1].notifications, 1);
  const [key] = h.values.keys();
  for (const invalid of ["1", "TRUE", "{}", "null", "false"]) {
    h.values.set(key, invalid);
    assert.equal(h.render().enabled, false);
  }
  assert.equal(h.stores[0].serverSnapshot(), false);
});

test("isolates users and organizations, including auth transitions", () => {
  const h = harness();
  h.render().setEnabled(true);
  h.auth.user.id = "user-b";
  assert.equal(h.render().enabled, false);
  h.auth.user.id = "user-a";
  h.auth.user.organizationId = "org-b";
  assert.equal(h.render().enabled, false);
  h.auth.user.organizationId = "org-a";
  assert.equal(h.render().enabled, true);
  h.auth.isLoading = true;
  assert.equal(h.render().enabled, false);
  h.auth.isLoading = false;
  h.auth.isLoggingOut = true;
  assert.equal(h.render().enabled, false);
  h.auth.isLoggingOut = false;
  h.auth.user = null;
  assert.equal(h.render().enabled, false);
  assert.equal(h.render().setEnabled(true), false);
});

test("fails closed on read or write errors and broadcasts a failed write", () => {
  const h = harness();
  const preference = h.render();
  preference.setEnabled(true);
  h.errors(true, false);
  assert.equal(h.render().enabled, false);
  h.errors(false, true);
  assert.equal(preference.setEnabled(false), false);
  assert.equal(h.stores[0].snapshot(), false);
  assert.equal(h.render().enabled, false);
  h.errors(false, false);
  assert.equal(preference.setEnabled(true), true);
  assert.equal(h.stores[0].snapshot(), true);
});

test("synchronizes other-tab updates and clear, ignoring unrelated storage events; unsubscribes", () => {
  const h = harness();
  h.render().setEnabled(true);
  const store = h.stores[0];
  const [key] = h.values.keys();
  const before = store.notifications;
  h.storage("unrelated-key");
  h.storage(key, {});
  assert.equal(store.notifications, before);
  h.values.set(key, "false");
  h.storage(key);
  assert.equal(store.notifications, before + 1);
  assert.equal(store.snapshot(), false);
  h.values.clear();
  h.storage(null);
  assert.equal(store.notifications, before + 2);
  assert.equal(store.snapshot(), false);
  store.unsubscribe();
  h.storage(key);
  assert.equal(store.notifications, before + 2);
});
