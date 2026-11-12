/** Driver one-click access links: #access=<43-char base64url token>. */
const TOKEN_RE = /^[A-Za-z0-9_-]{43}$/;

/** Extracts the token from a URL fragment (with or without leading '#'). Never from a query. */
export function parseAccessFragment(fragment: string | null | undefined): string | null {
  if (!fragment) return null;
  const raw = fragment.startsWith("#") ? fragment.slice(1) : fragment;
  for (const part of raw.split("&")) {
    const eq = part.indexOf("=");
    if (eq < 0 || part.slice(0, eq) !== "access") continue;
    const value = part.slice(eq + 1);
    return TOKEN_RE.test(value) ? value : null;
  }
  return null;
}

/** Extracts the fragment token from a full URL (native deep links). */
export function parseAccessUrl(url: string | null | undefined): string | null {
  if (!url) return null;
  const hash = url.indexOf("#");
  return hash < 0 ? null : parseAccessFragment(url.slice(hash));
}

export type DriverLinkFailure = "invalid" | "unavailable" | "network" | "notDriver" | "generic";

export function classifyDriverLinkError(err: unknown): DriverLinkFailure {
  const e = err as { status?: number; code?: string; name?: string; message?: string } | null;
  if (e?.message === "NOT_A_DRIVER" || e?.name === "NotADriverError") return "notDriver";
  if (e?.code === "DRIVER_LINK_INVALID") return "invalid";
  if (e?.code === "DRIVER_ACCESS_UNAVAILABLE") return "unavailable";
  if (e?.status === 0) return "network";
  if (e?.status === 401 || e?.status === 404 || e?.status === 410) return "invalid";
  if (e?.status === 403) return "unavailable";
  return "generic";
}

/**
 * One redemption per token for the app lifetime. Results (including failures)
 * are shared, so React strict-mode double effects and remounts never resend,
 * and an uncertain network failure is never retried automatically.
 */
export function createSingleFlight<T>() {
  const flights = new Map<string, Promise<T>>();
  return (key: string, run: () => Promise<T>): Promise<T> => {
    const existing = flights.get(key);
    if (existing) return existing;
    const p = run();
    flights.set(key, p);
    return p;
  };
}
