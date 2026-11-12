import assert from "node:assert/strict";
import { test } from "node:test";

test("validated operational popouts keep their original scope for raw/generated requests and fail closed after switch", async () => {
  const storage = new Map([["traivo.operational-workspace", "original-context"]]);
  const requests: Array<{ url: string; headers: Headers }> = [];
  let invalid = false;
  let failing = false;
  const nativeFetch = globalThis.fetch;
  const fakeWindow = {
    location: { href: "http://localhost/map-popout", origin: "http://localhost", pathname: "/map-popout" },
    opener: { location: { origin: "http://localhost" }, __traivoReadPopoutWorkspace: () => "original-context" },
    open: (href: string) => ({ location: new URL(href, "http://localhost/") }),
    dispatchEvent: () => { invalid = true; },
    fetch: async (input: RequestInfo | URL, init?: RequestInit) => {
      requests.push({ url: String(input), headers: new Headers(init?.headers) });
      return new Response(JSON.stringify(failing ? { code: "WORKSPACE_INVALID" } : { user: {}, session: {} }),
        { status: failing ? 403 : 200, headers: { "Content-Type": "application/json" } });
    },
  };
  Object.assign(globalThis, { window: fakeWindow, sessionStorage: {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  } });
  try {
    const { initialWorkspaceToken, openWorkspacePopout } = await import("./workspace-context");
    const childStorage = (token: string) => {
      const values = new Map([["traivo.operational-workspace", token]]);
      return {
        getItem: (key: string) => values.get(key) ?? null,
        setItem: (key: string, value: string) => { values.set(key, value); },
        removeItem: (key: string) => { values.delete(key); },
      };
    };
    for (const path of ["/map-popout", "/gantt-popout"]) {
      const popup = openWorkspacePopout(path, "_blank", "");
      assert.ok(popup);
      Object.assign(popup, { opener: fakeWindow });
      const ownStorage = childStorage("original-context");
      assert.equal(initialWorkspaceToken(popup, ownStorage, false), "original-context");
      storage.set("traivo.operational-workspace", "different-company");
      assert.equal(initialWorkspaceToken(popup, ownStorage, false), "original-context",
        "opener registry is pinned, not derived from its newly switched storage");
      assert.equal(initialWorkspaceToken(popup, ownStorage, true), "original-context",
        "reload retains the original grant for server revocation checking");
      assert.equal(initialWorkspaceToken(popup, childStorage("different-company"), false), "invalid-popout-workspace");
      const rogue = { location: new URL(path, "http://localhost/"), opener: fakeWindow } as unknown as Window;
      const rejected = childStorage("original-context");
      assert.equal(initialWorkspaceToken(rogue, rejected, false), "invalid-popout-workspace",
        "a same-origin but unregistered window cannot inherit operational authority");
      assert.equal(initialWorkspaceToken(rogue, rejected, true), "invalid-popout-workspace");
    }
    const generic = { location: new URL("http://localhost/settings"), opener: fakeWindow } as unknown as Window;
    assert.equal(initialWorkspaceToken(generic, childStorage("original-context"), false), null);
    globalThis.fetch = fakeWindow.fetch as typeof fetch;
    await fetch("/api/vehicles", { method: "POST", headers: { "Content-Type": "application/json" } });
    const { getAuthenticatedSession } = await import("@workspace/api-client-react");
    await getAuthenticatedSession();
    assert.equal(requests[0].headers.get("X-Traivo-Workspace"), "original-context");
    assert.equal(requests[1].headers.get("X-Traivo-Workspace"), "original-context");
    storage.set("traivo.operational-workspace", "different-company");
    await fetch("/api/vehicles");
    assert.equal(requests[2].headers.get("X-Traivo-Workspace"), "original-context");
    await fetch("https://external.example.test/upload");
    assert.equal(requests[3].headers.has("X-Traivo-Workspace"), false);
    failing = true;
    assert.equal((await fetch("/api/vehicles", { method: "POST" })).status, 403);
    assert.equal(invalid, true);
    assert.equal(requests.length, 5);
  } finally {
    globalThis.fetch = nativeFetch;
    Reflect.deleteProperty(globalThis, "window");
    Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});