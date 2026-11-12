import assert from "node:assert/strict";
import test from "node:test";
import { LiveViewBackoff, retryAfterDelay, LIVE_VIEW_POLL_MS } from "./live-view-backoff";

test("Retry-After supports seconds, HTTP dates and safe fallback", () => {
  const now = Date.parse("2026-11-09T10:00:00Z");
  assert.equal(retryAfterDelay("30", now), 30_000);
  assert.equal(retryAfterDelay("Mon, 09 Nov 2026 10:02:00 GMT", now), 120_000);
  for (const value of [null, "", "invalid", "-10", "0"]) assert.equal(retryAfterDelay(value, now), 60_000);
  assert.equal(LIVE_VIEW_POLL_MS, 10_000);
});

test("focus and realtime attempts cannot fetch during cooldown; recovery is automatic", () => {
  const backoff = new LiveViewBackoff();
  const error = backoff.pause("org:user:dispatcher", "30", 1000);
  assert.equal(error.status, 429);
  for (const now of [1001, 5000, 30_999]) {
    assert.throws(() => backoff.assertReady("org:user:dispatcher", now), (value) => value === error);
  }
  assert.equal(backoff.remaining("org:user:dispatcher", 21_000), 10_000);
  assert.doesNotThrow(() => backoff.assertReady("org:user:dispatcher", 31_000));
  assert.equal(backoff.remaining("org:user:dispatcher", 31_000), 0);
});

test("different actors are not blocked by another actor's cooldown", () => {
  const backoff = new LiveViewBackoff();
  backoff.pause("org:user1:dispatcher", null, 1000);
  assert.doesNotThrow(() => backoff.assertReady("org:user2:dispatcher", 1001));
  assert.doesNotThrow(() => backoff.assertReady("other:user1:dispatcher", 1001));
});
