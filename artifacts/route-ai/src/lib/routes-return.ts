/**
 * "Back to projects" support. Only a local /routes URL with validated list
 * filters is ever accepted, so a crafted returnTo can never redirect
 * externally or carry unknown parameters.
 */
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const STATUSES = new Set(["all", "active", "drafts", "completed"]);

export function sanitizeRoutesReturnTo(value: string | null | undefined): string | null {
  if (!value || typeof value !== "string" || value.length > 500) return null;
  if (!value.startsWith("/routes") || value.startsWith("//") || value.includes("\\")) return null;
  let url: URL;
  try {
    url = new URL(value, "https://local.invalid");
  } catch {
    return null;
  }
  if (url.origin !== "https://local.invalid" || url.pathname !== "/routes") return null;
  const out = new URLSearchParams();
  const q = url.searchParams.get("q");
  const status = url.searchParams.get("status");
  const date = url.searchParams.get("date");
  if (q) out.set("q", q.slice(0, 200));
  if (status && STATUSES.has(status)) out.set("status", status);
  if (date && DAY_RE.test(date)) out.set("date", date);
  const query = out.toString();
  return `/routes${query ? `?${query}` : ""}`;
}

export function readRoutesReturnTo(search: string): string | null {
  return sanitizeRoutesReturnTo(new URLSearchParams(search).get("returnTo"));
}

/** Copy a valid returnTo from the current search into freshly built params. */
export function carryRoutesReturnTo(params: URLSearchParams, search: string): URLSearchParams {
  const returnTo = readRoutesReturnTo(search);
  if (returnTo) params.set("returnTo", returnTo);
  else params.delete("returnTo");
  return params;
}
