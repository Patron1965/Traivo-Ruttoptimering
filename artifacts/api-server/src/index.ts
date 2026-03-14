import { env } from "./env";
import app from "./app";
import { autoSeed } from "./lib/auto-seed";

autoSeed()
  .then(() => {
    app.listen(env.PORT, () => {
      console.log(`Server listening on port ${env.PORT} (${env.NODE_ENV})`);
    });
  })
  .catch((err) => {
    console.error("Auto-seed failed:", err);
    app.listen(env.PORT, () => {
      console.log(`Server listening on port ${env.PORT} (seed failed)`);
    });
  });
