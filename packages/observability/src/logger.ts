/**
 * logger.ts — the structured logging pillar (ADR-009, R-05).
 *
 * A pino-backed structured logger that emits JSON log lines with a `service` field and whatever
 * request context (brand_id, correlation_id) the caller binds via `child()`. Every field object is
 * run through the NN-6 PII guard (redactLogRecord) BEFORE it reaches pino, so a PII-keyed field can
 * never land in a log line. Error values are reduced to `{ name, message }` — NEVER the stack, which
 * can carry PII (mirrors BrainSpan.recordException).
 *
 * This replaces ad-hoc console.* across the apps: a console.info has no level discipline, no
 * structure, no brand/correlation context, and no redaction. The default destination is stdout (a
 * collector/Loki scrapes it); tests inject a capturing destination.
 */
import pino from 'pino';
import { redactLogRecord } from './redact.js';
import { captureError } from './sentry.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface LogFields {
  [key: string]: unknown;
}

export interface BrainLogger {
  debug(msg: string, fields?: LogFields): void;
  info(msg: string, fields?: LogFields): void;
  warn(msg: string, fields?: LogFields): void;
  /** Log at error level. Pass the Error as `fields.err` / `fields.error`; only name+message survive. */
  error(msg: string, fields?: LogFields): void;
  /** Bind context (e.g. { brand_id, correlation_id }) onto every subsequent line — PII-redacted. */
  child(bindings: LogFields): BrainLogger;
}

export interface LoggerOptions {
  serviceName: string;
  /** Defaults to 'info' in production, 'debug' otherwise. */
  level?: LogLevel;
  /** Test/integration seam: a destination with write(str). Defaults to stdout. */
  destination?: { write(s: string): void };
}

/**
 * Reduce any Error value to a PII-safe { error_name, error_message } — never the stack (NN-6).
 * NB: the keys are `error_name`/`error_message`, NOT `name`/`message` — `name` is itself a PII key
 * (full name) and would be redacted away, hiding the error class.
 */
function normalizeErrors(fields: LogFields): LogFields {
  const out: LogFields = {};
  for (const [k, v] of Object.entries(fields)) {
    out[k] = v instanceof Error ? { error_name: v.name, error_message: v.message } : v;
  }
  return out;
}

function wrap(p: pino.Logger): BrainLogger {
  const emit = (level: LogLevel, msg: string, fields?: LogFields): void => {
    if (fields && Object.keys(fields).length > 0) {
      // Errors → {name,message} first, THEN redact PII keys, THEN hand to pino.
      const safe = redactLogRecord(normalizeErrors(fields));
      p[level](safe, msg);
    } else {
      p[level](msg);
    }
  };
  return {
    debug: (m, f) => emit('debug', m, f),
    info: (m, f) => emit('info', m, f),
    warn: (m, f) => emit('warn', m, f),
    error: (m, f) => {
      // Error-level logs are also error-tracking events: send the REAL Error (with stack) to Sentry
      // before the log redacts it to {error_name,error_message}. No-op when Sentry isn't initialized.
      const errVal = f?.['err'] ?? f?.['error'];
      if (errVal instanceof Error) {
        const extra = f ? { ...f, msg: m } : { msg: m };
        delete (extra as Record<string, unknown>)['err'];
        delete (extra as Record<string, unknown>)['error'];
        captureError(errVal, extra);
      }
      emit('error', m, f);
    },
    child: (bindings) => wrap(p.child(redactLogRecord(normalizeErrors(bindings)))),
  };
}

/**
 * Create a structured logger. Call once per process (then `child()` for request/job context).
 */
export function createLogger(opts: LoggerOptions): BrainLogger {
  const level = opts.level ?? (process.env['NODE_ENV'] === 'production' ? 'info' : 'debug');
  const pinoLogger = opts.destination
    ? pino({ level, base: { service: opts.serviceName } }, opts.destination as pino.DestinationStream)
    : pino({ level, base: { service: opts.serviceName } });
  return wrap(pinoLogger);
}
