import assert from "node:assert/strict";
import test from "node:test";
import {
  invalidateRouteQueries,
  isGeneratedRouteDetailQueryKey,
} from "./route-query-cache.ts";

test("recognizes generated route detail and detail-stops keys", () => {
  assert.equal(isGeneratedRouteDetailQueryKey(["/api/routes/route-a"]), true);
  assert.equal(
    isGeneratedRouteDetailQueryKey(["/api/routes/route-a/stops"]),
    true,
  );
  assert.equal(isGeneratedRouteDetailQueryKey(["/api/routes"]), false);
  assert.equal(
    isGeneratedRouteDetailQueryKey(["/api/routes/route-a/comparison"]),
    false,
  );
});

test("bounds generated detail invalidation when affected route IDs are known", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const queryClient = {
    invalidateQueries: (filters: Record<string, unknown>) => {
      calls.push(filters);
      return Promise.resolve();
    },
  };

  await invalidateRouteQueries(queryClient as never, ["route-a"]);

  assert.deepEqual(
    calls
      .filter((call) => call.queryKey)
      .map((call) => call.queryKey),
    [
      ["/api/routes"],
      ["/api/dashboard/stats"],
      ["/api/routes/route-a"],
      ["/api/routes/route-a/stops"],
    ],
  );
  const predicate = calls.find((call) => call.predicate)?.predicate as
    | ((query: { queryKey: readonly unknown[] }) => boolean)
    | undefined;
  assert.ok(predicate);
  assert.equal(predicate!({ queryKey: ["/api/routes/route-a"] }), true);
  assert.equal(predicate!({ queryKey: ["/api/routes/route-b"] }), false);
});

test("invalidates all generated route details when a resource event has no route IDs", async () => {
  const calls: Array<Record<string, unknown>> = [];
  const queryClient = {
    invalidateQueries: (filters: Record<string, unknown>) => {
      calls.push(filters);
      return Promise.resolve();
    },
  };

  await invalidateRouteQueries(queryClient as never);

  const predicate = calls.find((call) => call.predicate)?.predicate as
    | ((query: { queryKey: readonly unknown[] }) => boolean)
    | undefined;
  assert.ok(predicate);
  assert.equal(predicate!({ queryKey: ["/api/routes/route-a"] }), true);
  assert.equal(predicate!({ queryKey: ["/api/routes/route-a/stops"] }), true);
  assert.equal(predicate!({ queryKey: ["/api/routes/route-b/comparison"] }), false);
});