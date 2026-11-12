import { z } from "zod/v4";

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),
  PORT: z.string().min(1, "PORT is required").transform(Number).pipe(z.number().int().positive()),
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
});

function validateEnv() {
  const result = envSchema.safeParse(process.env);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    console.error("❌ Environment validation failed:\n" + issues);
    process.exit(1);
  }
  return result.data;
}

export const env = validateEnv();
