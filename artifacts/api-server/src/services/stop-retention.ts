import { deleteExpiredStops } from "./stop-service";

const CLEANUP_INTERVAL_MS = 12 * 60 * 60 * 1000;
let cleanupRunning = false;
let cleanupTimer: NodeJS.Timeout | null = null;

export async function runStopRetentionCleanup(): Promise<void> {
  if (cleanupRunning) return;
  cleanupRunning = true;
  try {
    const result = await deleteExpiredStops();
    if (result.stops > 0) {
      console.info(
        `[RETENTION] Deleted ${result.stops} terminal stops across ${result.organizations} organization(s).`,
      );
    }
  } catch (error) {
    console.error("[RETENTION] Stop cleanup failed:", error);
  } finally {
    cleanupRunning = false;
  }
}

export function startStopRetentionCleanup(): void {
  if (cleanupTimer) return;
  void runStopRetentionCleanup();
  cleanupTimer = setInterval(() => void runStopRetentionCleanup(), CLEANUP_INTERVAL_MS);
  cleanupTimer.unref?.();
}