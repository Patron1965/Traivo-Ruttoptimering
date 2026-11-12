import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";
import type { EnvConfig } from "./env-config";

async function compileConfig(production: boolean) {
  const result = await build({
    entryPoints: [fileURLToPath(new URL("./env-config.ts", import.meta.url))],
    bundle: true,
    write: false,
    platform: "node",
    format: "cjs",
    logLevel: "silent",
    ...(production ? { define: { "process.env.NODE_ENV": '"production"' } } : {}),
  });
  return result.outputFiles[0].text;
}

function validate(code: string, mode?: string): EnvConfig {
  const module = { exports: {} as { validateEnv: () => EnvConfig } };
  runInNewContext(code, {
    module,
    exports: module.exports,
    process: {
      env: {
        PORT: "8080",
        DATABASE_URL: "synthetic-test-database",
        ...(mode === undefined ? {} : { NODE_ENV: mode }),
        CORS_ALLOWED_ORIGINS: "https://example.test",
        RATE_LIMIT_MAX: "100",
      },
      exit: () => { throw new Error("Validation unexpectedly exited"); },
    },
    console,
  });
  return module.exports.validateEnv();
}

test("production bundle keeps production policy when runtime mode is missing or development", async () => {
  const code = await compileConfig(true);
  for (const runtimeMode of [undefined, "development", "production"]) {
    const config = validate(code, runtimeMode);
    assert.equal(config.NODE_ENV, "production");
    assert.equal(config.CORS_ALLOWED_ORIGINS, "https://example.test");
    assert.equal(config.RATE_LIMIT_MAX, 100);
    assert.equal(config.ALLOW_DEV_SEED, false);
  }
});

test("unbundled configuration preserves explicit modes and the development default", async () => {
  const code = await compileConfig(false);
  for (const mode of ["production", "development", "test"]) {
    assert.equal(validate(code, mode).NODE_ENV, mode);
  }
  assert.equal(validate(code).NODE_ENV, "development");
});
