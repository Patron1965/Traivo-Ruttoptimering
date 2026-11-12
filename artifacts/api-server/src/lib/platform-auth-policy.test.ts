import assert from "node:assert/strict";
import { test } from "node:test";
import { platformPasswordOnlyTestMode, sessionAuthenticationAllowed } from "./platform-auth-policy";

test("password-only mode is exact, default-off, production-capable and never bypasses recovery", () => {
  const original = process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE;
  const originalNodeEnv = process.env.NODE_ENV;
  const user = { isActive: true, isPlatformAdmin: true, mfaRecoveryRequired: false, lockedUntil: null, mfaLockedUntil: null };
  const session = { mfaVerifiedAt: null };
  try {
    for (const value of [undefined, "", "false", "TRUE", "1", " true "]) {
      if (value === undefined) delete process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE;
      else process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE = value;
      assert.equal(platformPasswordOnlyTestMode(), false);
      assert.equal(sessionAuthenticationAllowed(user, session), false);
      assert.equal(sessionAuthenticationAllowed(user, { mfaVerifiedAt: new Date() }), true);
    }
    process.env.NODE_ENV = "production";
    process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE = "true";
    assert.equal(sessionAuthenticationAllowed(user, session), true);
    assert.equal(session.mfaVerifiedAt, null);
    assert.equal(sessionAuthenticationAllowed({ ...user, mfaRecoveryRequired: true }, session), false);
    assert.equal(sessionAuthenticationAllowed({ ...user, isActive: false }, session), false);
    assert.equal(sessionAuthenticationAllowed(undefined, session), false);
    assert.equal(sessionAuthenticationAllowed({ ...user, mfaLockedUntil: new Date(Date.now() + 60_000) }, session), false);
    process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE = "false";
    assert.equal(sessionAuthenticationAllowed(user, session), false);
    assert.equal(sessionAuthenticationAllowed({ ...user, isPlatformAdmin: false }, session), true);
  } finally {
    if (original === undefined) delete process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE;
    else process.env.PLATFORM_PASSWORD_ONLY_TEST_MODE = original;
    if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
    else process.env.NODE_ENV = originalNodeEnv;
  }
});