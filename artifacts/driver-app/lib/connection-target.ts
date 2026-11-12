export function connectionTarget(input: {
  platform: string; development: boolean; domain?: string; nativePreviewOrigin?: string;
}) {
  // Published web is served beside /api. A build-time deployment hostname may
  // differ from the custom domain in an SMS link, causing a blocked CORS login.
  // Keep native and Expo's separate development web server on their configured
  // API origins.
  if (input.platform === "web" && !input.development) {
    return { apiBaseUrl: "/api", storagePrefix: "" };
  }
  const override = input.development && input.platform !== "web"
    ? input.nativePreviewOrigin?.trim() : undefined;
  if (override) {
    const url = new URL(override);
    if (url.protocol !== "https:" || url.username || url.password ||
      url.search || url.hash || url.pathname !== "/") {
      throw new Error("Native preview requires an HTTPS origin without credentials or a path");
    }
    return {
      apiBaseUrl: `${url.origin}/api`,
      storagePrefix: `native-preview:${encodeURIComponent(url.origin)}:`,
    };
  }
  return {
    apiBaseUrl: input.domain ? `https://${input.domain}/api`
      : input.platform === "web" ? "/api" : "http://localhost:8080/api",
    storagePrefix: "",
  };
}

interface Store {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<unknown>;
  removeItem(key: string): Promise<unknown>;
}

/** No migration or fallback: queued work must never cross backend boundaries. */
export function environmentStore(store: Store, prefix: string) {
  return {
    getItem: (key: string) => store.getItem(prefix + key),
    setItem: async (key: string, value: string) => { await store.setItem(prefix + key, value); },
    removeItem: async (key: string) => { await store.removeItem(prefix + key); },
    multiRemove: async (keys: readonly string[]) => {
      await Promise.all(keys.map(key => store.removeItem(prefix + key)));
    },
  };
}
