import express, { type Express } from "express";
import cors from "cors";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import router from "./routes";
import { authMiddleware } from "./middleware/auth";
import { getEnvConfig } from "./lib/env-config";

const app: Express = express();

app.use(helmet());
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(authMiddleware());

const config = getEnvConfig();
const limiter = rateLimit({
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max: config.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  keyGenerator: (req) => {
    const tenantId = req.headers["x-tenant-id"] as string | undefined;
    const ip = req.ip ?? "unknown";
    return tenantId ? `${tenantId}:${ip}` : ip;
  },
});
app.use(limiter);

app.use("/api", router);

export default app;
