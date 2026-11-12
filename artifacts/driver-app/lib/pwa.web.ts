export function prepareDriverPwa() {
  if (__DEV__ || typeof navigator === "undefined" || !("serviceWorker" in navigator)) return;
  const manifest = document.querySelector<HTMLLinkElement>('link[rel="manifest"]');
  if (!manifest) return;
  const base = new URL("./", manifest.href);
  void navigator.serviceWorker.register(new URL("driver-sw.js", base).href, { scope: base.pathname })
    .catch(() => { /* Installation is optional; the online app still works. */ });
  // Request durable storage. A declined request never means data was saved.
  void navigator.storage?.persist?.().catch(() => {});
}
