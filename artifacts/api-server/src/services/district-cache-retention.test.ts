import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { districtCacheRetentionEnabled } from "./district-cache-retention";

test("local file retention requires development and is never enabled in deployments", () => {
  assert.equal(districtCacheRetentionEnabled({ NODE_ENV: "development" }), true);
  assert.equal(districtCacheRetentionEnabled({ NODE_ENV: "development", REPLIT_DEPLOYMENT: "1" }), false);
  for (const NODE_ENV of ["production", "test", undefined]) {
    assert.equal(districtCacheRetentionEnabled({ NODE_ENV }), false);
  }
});

test("CommonJS production can import and start retention without resolving development resources", async () => {
  const result = await build({
    entryPoints: [new URL("./district-cache-retention.ts", import.meta.url).pathname],
    platform: "node",
    bundle: true,
    format: "cjs",
    minify: true,
    define: { "process.env.NODE_ENV": '"production"' },
    write: false,
    logLevel: "silent",
  });
  const context = {
    module: { exports: {} as { startDistrictCacheRetention?: () => void } },
    exports: {},
    require: createRequire(import.meta.url),
    process: { env: { NODE_ENV: "production" } },
    setInterval: () => assert.fail("Production must not schedule retention"),
    console,
  };
  runInNewContext(result.outputFiles[0].text, context);
  assert.equal(typeof context.module.exports.startDistrictCacheRetention, "function");
  context.module.exports.startDistrictCacheRetention!();
});