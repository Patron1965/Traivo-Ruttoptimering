import { accessSync, constants } from "node:fs";

// The existing Nix wrapper owns its compatible loader/library closure.
// Never mix arbitrary /nix/store libraries into the Node/API process environment.
export function chromiumLaunchOptions(
  env = process.env,
  platform = process.platform,
  isExecutable = (path) => {
    try {
      accessSync(path, constants.X_OK);
      return true;
    } catch {
      return false;
    }
  },
) {
  const override = env.E2E_CHROMIUM_EXECUTABLE_PATH;
  if (override) {
    if (!isExecutable(override)) {
      throw new Error("E2E_CHROMIUM_EXECUTABLE_PATH must point to an executable Chromium installation");
    }
    return { executablePath: override };
  }
  const nixChromium = "/repl/tools/bin/chromium";
  if (platform === "linux" && isExecutable(nixChromium)) {
    return { executablePath: nixChromium };
  }
  // Ordinary local/CI environments retain Playwright's bundled browser.
  return {};
}
