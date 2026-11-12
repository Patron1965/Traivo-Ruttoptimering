/** Bound both the request and response body; an outage must not spin forever. */
export async function readSession<T>(url: string, timeoutMs = 15_000): Promise<T | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { credentials: "include", signal: controller.signal });
    if (response.status === 401 || response.status === 403) return null;
    if (!response.ok) throw new Error("Session service unavailable");
    return await response.json() as T;
  } finally {
    clearTimeout(timer);
  }
}
