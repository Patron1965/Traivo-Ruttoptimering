import { createServer } from "http";
import { validateEnv } from "./lib/env-config";

const config = validateEnv();

import app from "./app";
import { autoSeed } from "./lib/auto-seed";
import { setupWebSocket } from "./ws";
import { startPriceRefresh } from "./services/electricity";

const server = createServer(app);
setupWebSocket(server);
startPriceRefresh();

autoSeed()
  .then(() => {
    server.listen(config.PORT, () => {
      console.log(`Server listening on port ${config.PORT} (${config.NODE_ENV})`);
    });
  })
  .catch((err) => {
    console.error("Auto-seed failed:", err);
    server.listen(config.PORT, () => {
      console.log(`Server listening on port ${config.PORT} (seed failed)`);
    });
  });
