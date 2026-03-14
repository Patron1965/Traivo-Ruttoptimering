import { createServer } from "http";
import { env } from "./env";
import app from "./app";
import { autoSeed } from "./lib/auto-seed";
import { setupWebSocket } from "./ws";

const server = createServer(app);
setupWebSocket(server);

autoSeed()
  .then(() => {
    server.listen(env.PORT, () => {
      console.log(`Server listening on port ${env.PORT} (${env.NODE_ENV})`);
    });
  })
  .catch((err) => {
    console.error("Auto-seed failed:", err);
    server.listen(env.PORT, () => {
      console.log(`Server listening on port ${env.PORT} (seed failed)`);
    });
  });
