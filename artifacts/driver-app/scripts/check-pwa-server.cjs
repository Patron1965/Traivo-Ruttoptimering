const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

(async () => {
  const probe = net.createServer();
  probe.listen(0, "127.0.0.1");
  await once(probe, "listening");
  const port = probe.address().port;
  await new Promise(resolve => probe.close(resolve));
  const env = { ...process.env, PORT: String(port) };
  delete env.BASE_PATH; // Exercise the actual production default, not a test override.
  const child = spawn(process.execPath, ["server/serve.js"], {
    cwd: path.resolve(__dirname, ".."),
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  try {
    await Promise.race([
      once(child.stdout, "data"),
      new Promise((_, reject) => setTimeout(() => reject(new Error("PWA server startup timed out")), 5000).unref()),
    ]);
    const origin = `http://127.0.0.1:${port}`;
    const root = await fetch(`${origin}/driver-app/`);
    assert.equal(root.status, 200);
    const html = await root.text();
    assert.ok(html.includes('rel="manifest"'));
    assert.ok(html.includes("/driver-app/_expo/static/"));
    const manifest = await fetch(`${origin}/driver-app/driver.webmanifest`);
    assert.equal(manifest.status, 200);
    assert.ok(manifest.headers.get("content-type").includes("application/manifest+json"));
    assert.equal((await manifest.json()).display, "standalone");
    const response = await fetch(`${origin}/driver-app/driver-sw.js`);
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-cache");
    const worker = await response.text();
    const assets = JSON.parse(worker.match(/SHELL\.push\(\.\.\.(\[.*\])\);/)[1]);
    assert.ok(assets.some(url => url.includes("/_expo/static/js/")));
    assert.ok(assets.some(url => url.endsWith(".ttf")));
    for (const url of assets) {
      assert.ok(url.startsWith("/driver-app/"));
      const asset = await fetch(origin + url);
      assert.equal(asset.status, 200, url);
      await asset.arrayBuffer();
    }
    const deepLink = await fetch(`${origin}/driver-app/proof/synthetic-stop`);
    assert.equal(await deepLink.text(), html);
    assert.ok(fs.existsSync(path.resolve(__dirname, "../static-build/web/driver-icon.png")));
    console.log(`PWA server passed: manifest, scope, deep-link shell and ${assets.length} precached assets.`);
  } finally {
    child.kill("SIGTERM");
    await once(child, "exit").catch(() => {});
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
