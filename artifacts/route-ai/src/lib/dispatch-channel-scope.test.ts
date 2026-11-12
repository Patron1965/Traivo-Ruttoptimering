import assert from "node:assert/strict";
import test from "node:test";
import { acceptsDispatchScope, dispatchChannelScope } from "./dispatch-channel-scope.ts";

test("selection, hover and clearing messages cannot cross owners, plans or days", () => {
  const current = dispatchChannelScope("org:user", "?planId=A&day=2026-11-11");
  assert.ok(acceptsDispatchScope(current, dispatchChannelScope("org:user", "?day=2026-11-11&planId=A&view=traffic")));
  for (const other of [
    dispatchChannelScope("org:user", "?planId=B&day=2026-11-11"),
    dispatchChannelScope("org:user", "?planId=A&day=2026-11-12"),
    dispatchChannelScope("other:user", "?planId=A&day=2026-11-11"),
    dispatchChannelScope("org:other", "?planId=A&day=2026-11-11"),
    dispatchChannelScope("org:user", "?planId=A&routeId=other&day=2026-11-11"),
    undefined, null, "",
  ]) assert.equal(acceptsDispatchScope(current, other), false);
});
