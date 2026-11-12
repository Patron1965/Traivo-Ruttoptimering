import assert from "node:assert/strict";
import test from "node:test";
import { finishTrackingSession, trackingStartIdentity, hasUnresolvedTrackingStops } from "./tracking-lifecycle.ts";
import { localizeError } from "./error-localizer.ts";

test("premature end and network failures retain device session; final end stops it", async () => {
  let deviceActive = true;
  const stopDevice = async () => { deviceActive = false; };
  for (const error of [Object.assign(new Error("remaining"), { code: "ROUTE_STOPS_REMAIN" }), new Error("network")]) {
    await assert.rejects(finishTrackingSession(async () => { throw error; }, stopDevice), error);
    assert.equal(deviceActive, true);
  }
  const summary = { status: "ended", pendingStops: 0 };
  assert.equal(await finishTrackingSession(async () => summary, stopDevice), summary);
  assert.equal(deviceActive, false);
});

test("GPS restart reuses active server identity without a conflicting timestamp", () => {
  assert.deepEqual(trackingStartIdentity({ status: "active", clientSessionId: "original" }, () => {
    throw new Error("must not create a new session");
  }), { clientSessionId: "original" });
  assert.equal(trackingStartIdentity(null, () => "new").clientSessionId, "new");
  assert.deepEqual(trackingStartIdentity({ status: "ended", clientSessionId: "legacy" }, () => "wrong"),
    { clientSessionId: "legacy" });
});

test("unloaded and unfinished stops block end, only terminal states allow it", () => {
  assert.equal(hasUnresolvedTrackingStops(undefined), true);
  for (const status of ["pending", "in_progress", "unknown"]) {
    assert.equal(hasUnresolvedTrackingStops([{ status }]), true);
  }
  assert.equal(hasUnresolvedTrackingStops(["completed", "failed", "skipped"].map(status => ({ status }))), false);
});

test("server's remaining-stop rejection gives actionable localized guidance", () => {
  assert.match(localizeError({ status: 409, code: "ROUTE_STOPS_REMAIN" }, "sv"), /medan stopp återstår/);
  assert.match(localizeError({ status: 409, code: "ROUTE_STOPS_REMAIN" }, "en"), /while stops remain/);
});