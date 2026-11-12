import { test } from "node:test";
import assert from "node:assert/strict";
import { chromiumLaunchOptions } from "./playwright-runtime.mjs";

test("uses the existing Nix wrapper without changing the environment", () => {
  const env = Object.freeze({ LD_LIBRARY_PATH: "/existing" });
  assert.deepEqual(chromiumLaunchOptions(env, "linux", () => true), {
    executablePath: "/repl/tools/bin/chromium",
  });
  assert.equal(env.LD_LIBRARY_PATH, "/existing");
});

test("explicit executable takes precedence and invalid overrides fail", () => {
  assert.deepEqual(chromiumLaunchOptions(
    { E2E_CHROMIUM_EXECUTABLE_PATH: "/custom/chromium" }, "linux", () => true,
  ), { executablePath: "/custom/chromium" });
  assert.throws(() => chromiumLaunchOptions(
    { E2E_CHROMIUM_EXECUTABLE_PATH: "/missing" }, "linux", () => false,
  ), /must point to an executable/);
});

test("other environments retain Playwright defaults", () => {
  assert.deepEqual(chromiumLaunchOptions({}, "linux", () => false), {});
  assert.deepEqual(chromiumLaunchOptions({}, "darwin", () => true), {});
});
