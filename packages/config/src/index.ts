/**
 * @brain/config — Zod-validated environment configuration.
 *
 * Pattern: parse env vars at startup, crash on invalid config (process.exit(1)).
 * This ensures misconfigured services fail immediately rather than silently.
 *
 * Usage:
 *   import { getConfig } from '@brain/config';
 *   const cfg = getConfig(); // throws / exits on missing required vars
 *
 * Sprint-0: stub config schema covering the required env vars for each service.
 * M1 expands each service's config as it is implemented.
 */
import { z } from 'zod';

// ── Common env vars ───────────────────────────────────────────────────────────

const CommonEnvSchema = z.object({
  /** Service name — used in OTel resource attrs and log fields. */
  SERVICE_NAME: z.string().min(1),
  /** Node environment. */
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  /** Log level. */
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** OTLP endpoint for OTel exporter (e.g. http://otel-collector:4317). */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

// ── Collector env vars ────────────────────────────────────────────────────────

export const CollectorEnvSchema = CommonEnvSchema.extend({
  SERVICE_NAME: z.literal('collector'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3001),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
  REDPANDA_BROKERS: z.string().min(1),
  REDPANDA_SASL_USERNAME: z.string().optional(),
  REDPANDA_SASL_PASSWORD: z.string().optional(),
  APICURIO_REGISTRY_URL: z.string().url().optional(),
  /** Rate limit: max events per brand per minute. */
  RATE_LIMIT_EVENTS_PER_MINUTE: z.coerce.number().int().min(1).default(10_000),
});

export type CollectorEnv = z.infer<typeof CollectorEnvSchema>;

// ── Core service env vars ─────────────────────────────────────────────────────

export const CoreEnvSchema = CommonEnvSchema.extend({
  SERVICE_NAME: z.literal('core'),
  PORT: z.coerce.number().int().min(1024).max(65535).default(3000),
  DATABASE_URL: z.string().url(),
  REDIS_URL: z.string().url().default('redis://localhost:6379'),
});

export type CoreEnv = z.infer<typeof CoreEnvSchema>;

// ── Prod-required credentials ───────────────────────────────────────────────────

/**
 * A secret/credential env var that MUST be set in production but keeps a frictionless dev default.
 *
 * In production, a missing/empty value is a FAIL-CLOSED startup error — we never silently fall back
 * to a known weak dev credential (e.g. a default analytics/DB password committed to the repo), which
 * would be a real footgun if an env var is forgotten in a prod deploy. Outside production, returns
 * the dev default so `pnpm dev` works without wiring secrets.
 *
 * @throws {Error} in production when the variable is unset/empty.
 */
export function requireEnvInProd(
  name: string,
  devDefault: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const val = env[name];
  if (val) return val;
  if (env['NODE_ENV'] === 'production') {
    throw new Error(
      `[config] ${name} must be set in production — refusing to fall back to the dev default ` +
        '(a known weak credential). Inject it from your secret store.',
    );
  }
  return devDefault;
}

// ── Generic config parser ─────────────────────────────────────────────────────

/**
 * Parse and validate an environment schema.
 * On validation failure, logs the errors and exits the process.
 *
 * @param schema - Zod schema to validate process.env against.
 * @param env - Environment map (defaults to process.env).
 */
export function parseEnv<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): z.infer<T> {
  const result = schema.safeParse(env);
  if (!result.success) {
    const errors = result.error.errors
      .map((e) => `  ${e.path.join('.')}: ${e.message}`)
      .join('\n');
    console.error(
      `[config] FATAL: Invalid environment configuration:\n${errors}\n` +
        'Fix the environment variables and restart the service.',
    );
    // process.exit(1) in real services; throw in tests.
    if (env === process.env) {
      process.exit(1);
    }
    throw new Error(`Invalid environment configuration:\n${errors}`);
  }
  return result.data;
}
