import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import { logger } from "../lib/logger";

let timer: NodeJS.Timeout | undefined;
let running: ChildProcess | undefined;

export function districtCacheRetentionEnabled(env: NodeJS.ProcessEnv): boolean {
  return env.NODE_ENV === "development" && env.REPLIT_DEPLOYMENT !== "1";
}

/** Private development files only. Never enabled by production startup. */
export function startDistrictCacheRetention(): void {
  if (timer || !districtCacheRetentionEnabled(process.env)) return;
  // Production is bundled as CommonJS: import.meta.url is unavailable there.
  // Resolve development-only resources only after the deployment guard.
  const script = fileURLToPath(new URL("../../../../scripts/district-cache-retention.py", import.meta.url));
  const clean = () => {
    if (running) return;
    const child = spawn("python", [script], { stdio: "ignore" });
    running = child;
    child.once("error", () => {
      running = undefined;
      logger.error({}, "Development district retention could not start; retrying next minute.");
    });
    child.once("exit", code => {
      running = undefined;
      if (code !== 0 && code !== 75) {
        logger.error({}, "Development district retention failed; inspect local cache safely.");
      }
    });
  };
  clean();
  timer = setInterval(clean, 60_000);
  timer.unref();
  process.once("exit", () => running?.kill());
  logger.info({}, "Development district retention enabled (60-second checks, shared sample lock).");
}