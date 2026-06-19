/**
 * sentry.ts — error tracking (ADR-009 / R-05, the half beyond tracing+metrics+logging).
 *
 * Gated by SENTRY_DSN exactly like the OTLP exporter: with no DSN (dev/test) this is a complete
 * no-op — @sentry/node is lazily imported only when a DSN is present, so it costs nothing when off.
 * When on, unhandled + explicitly-captured errors are sent to Sentry with the service + environment
 * tagged.
 *
 * PII safety (NN-6): sendDefaultPii is false (no request bodies/headers/cookies/IP/user), and a
 * beforeSend hook runs every event's `extra`/`contexts`/`tags` through redactLogRecord so a
 * PII-keyed field can never be sent. The exception STACK is sent (it is the point of error
 * tracking, and Sentry is access-controlled) — but messages must not embed raw PII (a convention).
 */
import { redactLogRecord } from './redact.js';

type SentryLike = {
  init(opts: Record<string, unknown>): void;
  captureException(err: unknown, hint?: { extra?: Record<string, unknown> }): void;
  close(timeoutMs?: number): Promise<boolean>;
};

let sentry: SentryLike | null = null;

export interface SentryOptions {
  serviceName: string;
  dsn?: string;
  environment?: string;
  /** 0..1 — fraction of transactions traced (default 0, error-only). */
  tracesSampleRate?: number;
}

/**
 * Initialize Sentry error tracking — call ONCE per process from main.ts. No-op without a DSN.
 * Returns an async flush+close fn for graceful shutdown.
 */
export async function initSentry(opts: SentryOptions): Promise<() => Promise<void>> {
  const dsn = opts.dsn ?? process.env['SENTRY_DSN'];
  if (!dsn || sentry) {
    return async () => {};
  }
  const mod = (await import('@sentry/node')) as unknown as SentryLike;
  mod.init({
    dsn,
    environment: opts.environment ?? process.env['NODE_ENV'] ?? 'development',
    serverName: opts.serviceName,
    sendDefaultPii: false, // never auto-attach request bodies/headers/cookies/IP/user (NN-6)
    tracesSampleRate: opts.tracesSampleRate ?? 0,
    initialScope: { tags: { service: opts.serviceName } },
    // Scrub structured event data through the same PII guard the logger uses.
    beforeSend(event: Record<string, unknown>) {
      if (event['extra']) event['extra'] = redactLogRecord(event['extra'] as Record<string, unknown>);
      if (event['contexts']) event['contexts'] = redactLogRecord(event['contexts'] as Record<string, unknown>);
      if (event['tags']) event['tags'] = redactLogRecord(event['tags'] as Record<string, unknown>);
      return event;
    },
  });
  sentry = mod;
  return async () => {
    await mod.close(2000).catch(() => false);
  };
}

/**
 * Capture an error to Sentry (no-op when not initialized). `extra` is PII-redacted before send.
 * The logger calls this on every error-level log, so wired error tracking is automatic.
 */
export function captureError(err: unknown, extra?: Record<string, unknown>): void {
  if (!sentry) return;
  const safe = extra ? redactLogRecord(extra) : undefined;
  sentry.captureException(err, safe ? { extra: safe } : undefined);
}

/** TEST-ONLY: inject a fake Sentry transport + reset (so capture is observable without a real DSN). */
export function __setSentryForTest(fake: SentryLike | null): void {
  sentry = fake;
}
