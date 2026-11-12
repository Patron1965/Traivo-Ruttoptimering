import { createServer } from "http";
import { validateEnv } from "./lib/env-config";

const config = validateEnv();

import app from "./app";
import { autoSeed } from "./lib/auto-seed";
import { ensureSeedCredentials } from "./lib/seed-credentials";
import { ensureBootstrapAdmin } from "./lib/bootstrap-admin";
import { ensureResourceProfiles } from "./services/resource-compatibility";
import { checkSchemaHealth } from "./lib/schema-health-check";
import { runStartupSteps } from "./lib/startup-steps";
import { pool } from "@workspace/db";
import { setupWebSocket } from "./ws";
import { startPriceRefresh } from "./services/electricity";
import { startStopRetentionCleanup } from "./services/stop-retention";
import { startDistrictWorker } from "./services/district-worker";
import { installDatabaseConnectionErrorHandlers } from "./lib/database-connection-errors";
import { logger } from "./lib/logger";
import { startDistrictCacheRetention } from "./services/district-cache-retention";
import { purgeExpiredRuntimeState } from "./services/planning-runtime-store";

installDatabaseConnectionErrorHandlers(pool, () => {
  logger.error(
    { event: "database_connection_error" },
    "Database connection failed; affected queries remain failed and are not replayed",
  );
});
const server = createServer(app);
setupWebSocket(server);
startPriceRefresh();
startDistrictCacheRetention();

runStartupSteps([
  { name: "database connection (SELECT 1)", run: () => pool.query("SELECT 1") },
  { name: "required database schema and customer-link guard", run: checkSchemaHealth },
  { name: "development seed", run: autoSeed },
  { name: "development credentials", run: ensureSeedCredentials },
  { name: "administrator bootstrap", run: ensureBootstrapAdmin },
  { name: "unified resource compatibility", run: ensureResourceProfiles },
])
  .then(() => {
    const cleanupRuntime = () => void purgeExpiredRuntimeState().catch(() => {
      logger.error({ event: "planning_runtime_retention_failed" }, "Could not purge expired planning runtime state");
    });
    cleanupRuntime();
    const runtimeRetention = setInterval(cleanupRuntime, 5 * 60_000);
    runtimeRetention.unref();
    startStopRetentionCleanup();
    startDistrictWorker();
    server.listen(config.PORT, () => {
      console.log(`Server listening on port ${config.PORT} (${config.NODE_ENV})`);
    });
  })
  .catch((err) => {
    console.error("Startup initialization failed:", err);
    process.exit(1);
  });
