import assert from "node:assert/strict";
import test from "node:test";
import {
  ensureServerSessionVerified,
  setSessionVerificationHandler,
  isServerSessionVerified,
  setServerSessionVerified,
  subscribeToSessionVerification,
} from "./session-verification.ts";

test("verified login and reconnect notify consumers without a connectivity event", () => {
  setServerSessionVerified(false);
  const snapshots = [];
  const unsubscribe = subscribeToSessionVerification(() => snapshots.push(isServerSessionVerified()));
  assert.equal(isServerSessionVerified(), false);
  setServerSessionVerified(true);
  setServerSessionVerified(true);
  setServerSessionVerified(false);
  setServerSessionVerified(true);
  assert.deepEqual(snapshots, [true, false, true]);
  unsubscribe();
  setServerSessionVerified(false);
  assert.equal(isServerSessionVerified(), false);
  assert.deepEqual(snapshots, [true, false, true]);
});

test("an operation waits for renewed verification rather than failing before fetch", async () => {
  setServerSessionVerified(false);
  let release;
  const ready = new Promise(resolve => { release = resolve; });
  setSessionVerificationHandler(async () => {
    await ready;
    setServerSessionVerified(true);
    return true;
  });
  let settled = false;
  const attempt = ensureServerSessionVerified().then(ok => { settled = true; return ok; });
  await Promise.resolve();
  assert.equal(settled, false);
  release();
  assert.equal(await attempt, true);
  setSessionVerificationHandler(null);
  setServerSessionVerified(false);
});

test("a callback result alone never authorizes expired or changed sessions", async () => {
  setServerSessionVerified(false);
  setSessionVerificationHandler(async () => true);
  assert.equal(await ensureServerSessionVerified(), false);
  setSessionVerificationHandler(async () => {
    setSessionVerificationHandler(null);
    setServerSessionVerified(true);
    return true;
  });
  assert.equal(await ensureServerSessionVerified(), false);
  setServerSessionVerified(false);
  assert.equal(await ensureServerSessionVerified(), false);
});
