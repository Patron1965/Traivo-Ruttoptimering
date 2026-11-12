import type { Pool } from "pg";

/**
 * pg-pool's idle listener is removed while a client is checked out. A server
 * disconnect between transaction queries otherwise becomes an unhandled
 * EventEmitter error (and terminates the entire API process).
 *
 * pg itself marks these clients non-queryable before emitting the error:
 * subsequent writes/COMMIT reject and release() destroys the broken client.
 * Do not reconnect, retry a statement, or turn that failure into success.
 */
export function observeClientErrors(pool: Pool): void {
  const report = (error: Error & { code?: string }) => {
    console.error("[database] connection failed", {
      name: error.name,
      code: error.code ?? "CONNECTION_ERROR",
    });
  };
  pool.on("connect", (client) => {
    client.on("error", report);
  });
  pool.on("error", report);
}
