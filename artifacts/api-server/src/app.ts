import express, { type Express, type Request, type Response, type NextFunction } from "express";
import cors from "cors";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import router from "./routes";
import { authMiddleware } from "./middleware/auth";
import { auditMiddleware } from "./middleware/audit";
import { getEnvConfig } from "./lib/env-config";
import { initSentry, captureException } from "./lib/sentry";
import { withRequiredRoadData, RoadDataUnavailableError } from "./services/road-data-policy";
import { prepareOperationalRoadData } from "./middleware/operational-road-data";
import { createPortalRouter } from "./routes/portal";
import { operationalRateKey } from "./lib/operational-rate-key";

initSentry();

const app: Express = express();
const config = getEnvConfig();
const allowedOrigins = new Set(
  config.CORS_ALLOWED_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean),
);

app.use(helmet());
app.use(cors({
  credentials: true,
  origin(origin, callback) {
    if (!origin || config.NODE_ENV !== "production" || allowedOrigins.has(origin)) {
      callback(null, true);
      return;
    }
    callback(null, false);
  },
}));
// Applied before parsers/auth/global limiters, so error responses cannot cache
// bearer URLs either. Public token paths must never be recorded in telemetry.
app.use((req, res, next) => {
  if (/^\/api\/track(?:\/|$)/.test(req.path) || /^\/api\/stops\/[^/]+\/customer-link/.test(req.path)) {
    res.set({ "Cache-Control": "no-store, private", "Pragma": "no-cache", "Referrer-Policy": "no-referrer", "X-Robots-Tag": "noindex, nofollow, noarchive" });
  }
  next();
});
app.use(cookieParser());
app.use(express.json({ limit: "20mb" }));
app.use(express.urlencoded({ extended: true, limit: "20mb" }));
// Separate customer principal and cookie; portal credentials never enter staff auth.
app.use("/api/portal", createPortalRouter());
app.use(authMiddleware());
app.use(auditMiddleware);

const limiter = rateLimit({
  // Public bearer-link reads have their own stricter, identity-independent
  // limiter and generic JSON response. Avoid a later plaintext/global limit
  // changing that contract after repeated invalid-token probes.
  skip: (req) => /^\/api\/track\/[^/]+\/?$/.test(req.path),
  windowMs: config.RATE_LIMIT_WINDOW_MS,
  max:
    config.NODE_ENV === "development"
      // Full planning acceptance flows include per-route reads and polling.
      // Keep this development-only; production and portal auth limits stay strict.
      ? Math.max(config.RATE_LIMIT_MAX, 2_000)
      : config.RATE_LIMIT_MAX,
  standardHeaders: true,
  legacyHeaders: false,
  validate: false,
  handler: (req, res) => {
    if (/\/customer-link\/?$/.test(req.path)) {
      res.status(429).json({ error: "Too many requests", code: "RATE_LIMITED" });
      return;
    }
    res.status(429).send("Too many requests, please try again later.");
  },
  keyGenerator: operationalRateKey,
});
app.use(limiter);

// Includes read-only planning previews: an estimate must never become an
// apparently verified workday just because it came from a GET endpoint.
app.use("/api", (_req, _res, next) => withRequiredRoadData(next), prepareOperationalRoadData, router);

app.use((err: Error, req: Request, res: Response, _next: NextFunction) => {
  if (err instanceof RoadDataUnavailableError) {
    if (!res.headersSent) res.status(err.statusCode).json({ error: err.message, code: err.code });
    return;
  }
  const parserError = err as Error & { type?: string; status?: number };
  if (parserError.type === "entity.parse.failed") {
    res.status(400).json({ error: "Malformed JSON request body", code: "INVALID_JSON" });
    return;
  }
  if (parserError.type === "entity.too.large" || parserError.status === 413) {
    res.status(413).json({ error: "Request body is too large", code: "BODY_TOO_LARGE" });
    return;
  }
  captureException(/^\/api\/track(?:\/|$)/.test(req.path) ? new Error("Public tracking request failed") : err, {
    path: /^\/api\/track(?:\/|$)/.test(req.path) ? "/api/track/[redacted]" : req.path,
    method: req.method,
    requestId: req.requestId,
  });
  console.error("[ERROR]", /^\/api\/track(?:\/|$)/.test(req.path) ? "Public tracking request failed" : err?.message || err);
  if (res.headersSent) return;
  res.status(500).json({ error: "Internal server error", requestId: req.requestId });
});

export default app;
