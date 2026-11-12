// Immutable for this document. Switching always creates a new document; old
// callbacks, raw fetches and generated clients retain the old credential.
const KEY = "traivo.operational-workspace";
const INVALID_POPOUT = "invalid-popout-workspace";
declare global {
  interface Window {
    __traivoReadPopoutWorkspace?: (popup: Window) => string | null | undefined;
  }
}

/** Only a Dispatch-created, same-origin map/Gantt window may inherit the
 * opener document's ORIGINAL scope. Never consult the opener's mutable storage. */
export function initialWorkspaceToken(win: Window, storage: Pick<Storage, "getItem" | "setItem" | "removeItem">, reload: boolean) {
  const inherited = storage.getItem(KEY);
  if (!win.opener || reload) return inherited;
  if (/\/(?:map|gantt)-popout\/?$/.test(win.location.pathname) && inherited) {
    try {
      if (win.opener.location.origin === win.location.origin &&
        win.opener.__traivoReadPopoutWorkspace?.(win) === inherited) return inherited;
    } catch { /* Cross-origin, navigated or unavailable opener: fail closed. */ }
    storage.setItem(KEY, INVALID_POPOUT);
    return INVALID_POPOUT;
  }
  storage.removeItem(KEY);
  return null;
}

const browser = typeof window !== "undefined" && typeof sessionStorage !== "undefined";
const navigation = browser ? performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined : undefined;
export const workspaceToken = browser ? initialWorkspaceToken(window, sessionStorage, navigation?.type === "reload") : null;
const popouts = new WeakMap<Window, { token: string | null; path: string }>();
if (browser) window.__traivoReadPopoutWorkspace = popup => {
  const registered = popouts.get(popup);
  if (!registered) return undefined;
  try {
    if (popup.location.origin !== window.location.origin || popup.location.pathname !== registered.path) return undefined;
  } catch { return undefined; }
  return registered.token;
};

export function openWorkspacePopout(href: string, name: string, features: string) {
  const url = new URL(href, window.location.href);
  if (url.origin !== window.location.origin || !/\/(?:map|gantt)-popout\/?$/.test(url.pathname)) {
    throw new Error("Ogiltigt fönster för företagsåtkomst.");
  }
  const popup = window.open(href, name, features);
  // Registration completes synchronously before the new document executes.
  if (popup) popouts.set(popup, { token: workspaceToken, path: url.pathname });
  return popup;
}
let failed = false;
export const workspaceFailed = () => failed;
export const clearLocalWorkspace = () => sessionStorage.removeItem(KEY);
const originalFetch = browser ? window.fetch.bind(window) : globalThis.fetch;
/** Unpatched fetch: never carries staff workspace headers (customer portal). */
export const untaggedFetch: typeof fetch = (input, init) => originalFetch(input, init);

if (browser) window.fetch = async (input, init) => {
  const url = new URL(input instanceof Request ? input.url : String(input), window.location.href);
  if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return originalFetch(input, init);
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  if (workspaceToken) headers.set("X-Traivo-Workspace", workspaceToken);
  const response = await originalFetch(input, { ...init, headers });
  if (workspaceToken && (response.status === 401 || response.status === 403)) {
    const body = await response.clone().json().catch(() => null);
    if (body?.code === "WORKSPACE_INVALID") {
      failed = true;
      window.dispatchEvent(new Event("traivo-workspace-invalid"));
    }
  }
  return response;
};

export async function enterWorkspace(organizationId: string) {
  const response = await fetch("/api/platform/workspace", { method: "POST",
    headers: { "Content-Type": "application/json" }, body: JSON.stringify({ organizationId }) });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || "Företagsåtkomsten kunde inte öppnas.");
  sessionStorage.setItem(KEY, data.token);
  clearWorkspaceDrafts();
  window.location.assign("/");
}

export async function leaveWorkspace() {
  if (workspaceToken) {
    const response = await fetch("/api/platform/workspace", { method: "DELETE" });
    // Expiry/revocation already means no operational authority remains.
    if (!response.ok && ![401, 403].includes(response.status)) throw new Error("Företagsåtkomsten kunde inte stängas. Försök igen.");
  }
  sessionStorage.removeItem(KEY);
  clearWorkspaceDrafts();
  window.location.assign("/platform");
}

function clearWorkspaceDrafts() {
  // Query caches and component drafts disappear with the full document
  // navigation. Also discard persisted plan selection/progress recovery aids.
  for (const key of Object.keys(sessionStorage)) {
    if (key.startsWith("traivo:last-route-plan:") || key.startsWith("traivo:import-route-plan-progress:")) sessionStorage.removeItem(key);
  }
}