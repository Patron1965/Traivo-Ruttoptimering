const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const root = path.resolve(__dirname, "..");
const base = require("../pwa-config.cjs").getWebBasePath();
fs.copyFileSync(path.join(root, "assets/images/icon.png"), path.join(root, "public/driver-icon.png"));
// Keep Expo's runtime configuration static. Apply the deployment prefix only
// during the web export and restore the exact source even if the export fails.
const configPath = path.join(root, "app.json");
const originalConfig = fs.readFileSync(configPath, "utf8");
const restoreConfig = () => fs.writeFileSync(configPath, originalConfig);
process.once("exit", restoreConfig);
process.once("SIGTERM", () => process.exit(143));
process.once("SIGINT", () => process.exit(130));
const exportConfig = JSON.parse(originalConfig);
exportConfig.expo.experiments = {
  ...exportConfig.expo.experiments,
  baseUrl: base.replace(/\/$/, ""),
};
let result;
try {
  fs.writeFileSync(configPath, JSON.stringify(exportConfig, null, 2) + "\n");
  result = spawnSync("pnpm", ["exec", "expo", "export", "--platform", "web", "--output-dir", "static-build/web"], {
    cwd: root, stdio: "inherit",
    env: { ...process.env, EXPO_PUBLIC_WEB_BASE_PATH: base },
  });
} finally {
  restoreConfig();
  process.removeListener("exit", restoreConfig);
}
if (result.status !== 0) process.exit(result.status ?? 1);
const output = path.join(root, "static-build/web");
const indexPath = path.join(output, "index.html");
const html = fs.readFileSync(indexPath, "utf8");
// Expo's single-page output does not render +html.tsx.
if (!html.includes('rel="manifest"')) {
  fs.writeFileSync(indexPath, html.replace("</head>", [
    '<meta name="theme-color" content="#164B3B">',
    '<meta name="apple-mobile-web-app-capable" content="yes">',
    `<link rel="manifest" href="${base}driver.webmanifest">`,
    `<link rel="apple-touch-icon" href="${base}driver-icon.png">`,
    "</head>",
  ].join("\n")));
}
function walk(dir) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const file = path.join(dir, entry.name);
    return entry.isDirectory() ? walk(file) : [file];
  });
}
const assets = walk(output).map(file => path.relative(output, file).replaceAll(path.sep, "/"))
  .filter(file => (file.startsWith("_expo/static/") || file.startsWith("assets/")) && !file.endsWith(".map"))
  .map(file => base + file);
const worker = path.join(output, "driver-sw.js");
const crypto = require("node:crypto");
const version = crypto.createHash("sha256").update(fs.readFileSync(indexPath)).digest("hex").slice(0, 12);
let script = fs.readFileSync(worker, "utf8").replace('`${CACHE_PREFIX}v1`', `\`\${CACHE_PREFIX}${version}\``);
script = script.replace('const staticAsset =', `SHELL.push(...${JSON.stringify(assets)});\nconst staticAsset =`);
fs.writeFileSync(worker, script);
