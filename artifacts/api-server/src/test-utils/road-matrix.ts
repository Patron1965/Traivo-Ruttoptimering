/** Synthetic road-provider response for service tests. Never imported by app code. */
export function installSyntheticRoadMatrix(): () => void {
  const previous = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (!url.pathname.includes("/table/v1/")) return previous(input, init);
    const points = url.pathname.split("/").at(-1)!.split(";");
    const indices = (key: string) => url.searchParams.has(key)
      ? url.searchParams.get(key)!.split(";").map(Number) : points.map((_, i) => i);
    const sources = indices("sources"), destinations = indices("destinations");
    return new Response(JSON.stringify({
      code: "Ok",
      distances: sources.map(i => destinations.map(j => points[i] === points[j] ? 0 : 1000 + i * 10 + j)),
      durations: sources.map(i => destinations.map(j => points[i] === points[j] ? 0 : 120 + i + j)),
    }));
  }) as typeof fetch;
  return () => { globalThis.fetch = previous; };
}
