import app from "./app";
import { autoSeed } from "./lib/auto-seed";

const rawPort = process.env["PORT"];

if (!rawPort) {
  throw new Error(
    "PORT environment variable is required but was not provided.",
  );
}

const port = Number(rawPort);

if (Number.isNaN(port) || port <= 0) {
  throw new Error(`Invalid PORT value: "${rawPort}"`);
}

autoSeed()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on port ${port}`);
    });
  })
  .catch((err) => {
    console.error("Auto-seed failed:", err);
    app.listen(port, () => {
      console.log(`Server listening on port ${port} (seed failed)`);
    });
  });
