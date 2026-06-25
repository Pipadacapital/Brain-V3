/**
 * @brain/config — common (shared) configuration primitives.
 *
 * This module owns the cross-service building blocks that every per-service
 * config file composes on top of:
 *   - CommonEnvSchema   — env vars shared by all services.
 *   - requireEnvInProd  — fail-closed prod credential helper.
 *   - parseEnv          — the validate-or-crash parser.
 *   - defineConfig      — the memoized + frozen loader factory.
 *
 * Pattern: parse env vars at startup, crash on invalid config (process.exit(1)).
 * This ensures misconfigured services fail immediately rather than silently.
 *
 * Per-service config (core/collector/stream-worker/web) lives in its OWN file so
 * service agents can fill it without touching the others. This file is the only
 * shared surface — keep it small and stable.
 */
import { z } from 'zod';

// ── Common env vars ───────────────────────────────────────────────────────────

export const CommonEnvSchema = z.object({
  /** Service name — used in OTel resource attrs and log fields. */
  SERVICE_NAME: z.string().min(1),
  /** Node environment. */
  NODE_ENV: z.enum(['development', 'test', 'staging', 'production']).default('development'),
  /** Log level. */
  LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal']).default('info'),
  /** OTLP endpoint for OTel exporter (e.g. http://otel-collector:4317). */
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().url().optional(),
});

export type CommonEnv = z.infer<typeof CommonEnvSchema>;

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

// ── Memoized loader factory ───────────────────────────────────────────────────

/**
 * Build a memoized, frozen config loader for a given schema.
 *
 * The returned function parses `env` exactly ONCE per process (via {@link parseEnv},
 * preserving the validate-or-crash contract), freezes the result, and returns the
 * same cached object on every subsequent call. This gives each service a single
 * source of record for its config that is parsed lazily on first access.
 *
 * @example
 *   export const loadCoreConfig = defineConfig(CoreEnvSchema);
 *   const cfg = loadCoreConfig(); // parsed+frozen on first call; cached thereafter
 *
 * @param schema - Zod schema to validate the environment against.
 * @param env - Environment map (defaults to process.env). Bound at factory time.
 */
export function defineConfig<T extends z.ZodType>(
  schema: T,
  env: Record<string, string | undefined> = process.env,
): () => z.infer<T> {
  let cached: z.infer<T> | undefined;
  return () => (cached ??= Object.freeze(parseEnv(schema, env)));
}
