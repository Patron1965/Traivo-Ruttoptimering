import type { EventEmitter } from "node:events";

const installedPools = new WeakSet<EventEmitter>();

/**
 * pg rejects affected queries itself. Its separate error event must also have
 * a listener, including while a client is checked out and the pool's idle
 * listener has been removed. Never retry writes or log raw connection errors.
 */
export function installDatabaseConnectionErrorHandlers(
  pool: EventEmitter,
  report: () => void,
): void {
  if (installedPools.has(pool)) return;
  installedPools.add(pool);
  const reportedErrors = new WeakSet<object>();
  const onError = (error: unknown) => {
    if (typeof error === "object" && error !== null) {
      if (reportedErrors.has(error)) return;
      reportedErrors.add(error);
    }
    report();
  };
  pool.on("error", onError);
  pool.on("connect", (client: EventEmitter) => {
    client.on("error", onError);
  });
}
