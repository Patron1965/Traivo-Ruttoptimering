/** Selection messages are private to one signed-in owner and URL scope. */
export function dispatchChannelScope(owner: string, search: string): string {
  const params = new URLSearchParams(search);
  return JSON.stringify([owner, params.get("planId"), params.get("routeId"), params.get("day")]);
}

export function acceptsDispatchScope(expected: string, received: unknown): boolean {
  return typeof received === "string" && received === expected;
}
