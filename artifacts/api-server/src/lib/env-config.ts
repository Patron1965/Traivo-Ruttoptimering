import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  ALLOW_DEV_SEED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  CORS_ALLOWED_ORIGINS: z.string().default(""),
  /**
   * Absolute trusted web origin used in password-reset links. Never derive
   * this from the incoming Host header.
   */
  AUTH_APP_ORIGIN: z.string().url().optional().or(z.literal("")),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
  SESSION_IDLE_TIMEOUT_MIN: z.coerce.number().int().min(5).max(60).default(15),
  SESSION_ABSOLUTE_TIMEOUT_HOURS: z.coerce.number().int().min(1).max(24).default(8),
  ACCOUNT_LOCKOUT_THRESHOLD: z.coerce.number().int().positive().default(5),
  ACCOUNT_LOCKOUT_WINDOW_MIN: z.coerce.number().int().positive().default(15),
  ACCOUNT_LOCKOUT_DURATION_MIN: z.coerce.number().int().positive().default(15),
});

export type EnvConfig = z.infer<typeof envSchema>;

let _config: EnvConfig | null = null;

export function validateEnv(): EnvConfig {
  // Production builds replace this direct access with their build-time mode.
  // Passing process.env alone bypasses that replacement and can make cookie,
  // CORS and rate-limit policy disagree with the rest of the built server.
  const result = envSchema.safeParse({
    ...process.env,
    NODE_ENV: process.env.NODE_ENV,
  });
  if (!result.success) {
    const formatted = result.error.issues.map(i => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    console.error("❌ Environment validation failed:\n" + formatted);
    process.exit(1);
  }
  _config = result.data;
  return _config;
}

export function getEnvConfig(): EnvConfig {
  if (!_config) {
    return validateEnv();
  }
  return _config;
}
