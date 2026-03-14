import { z } from "zod";

const envSchema = z.object({
  PORT: z.coerce.number().int().positive(),
  DATABASE_URL: z.string().min(1),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(100),
});

export type EnvConfig = z.infer<typeof envSchema>;

let _config: EnvConfig | null = null;

export function validateEnv(): EnvConfig {
  const result = envSchema.safeParse(process.env);
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
