/**
 * Shared structured logger for the stream-worker deployable. Import `{ log }` and use log.info/warn/error
 * instead of console.* — every line is JSON with the service field + NN-6 PII redaction, and
 * error-level logs forward the Error to Sentry when enabled. Request/job code may `log.child({...})`
 * to bind brand_id / correlation_id.
 *
 * CORRELATION DISCIPLINE (V4 observability): when an orchestrator launches a worker job with a
 * correlation id in the environment (the v4-refresh-loop exports V4_CORRELATION_ID per refresh cycle;
 * a generic CORRELATION_ID is also honored), bind it onto the BASE logger here so EVERY line the job
 * emits carries that `correlation_id` — without each job entrypoint having to remember to `.child(...)`.
 * This is the worker half of the repo's correlation_id/brand_id child-logger standard: the Spark jobs
 * echo the same id (job_log.py), so a whole pipeline cycle's lines — Spark + worker — share one id.
 * Per-brand jobs still `log.child({ brand_id })` for the tenant dimension (brand_id is per-iteration,
 * never process-wide, so it is correctly NOT bound here).
 */
import { createLogger } from '@brain/observability';

const baseLog = createLogger({ serviceName: 'stream-worker' });

const correlationId = process.env['V4_CORRELATION_ID'] ?? process.env['CORRELATION_ID'];

export const log = correlationId ? baseLog.child({ correlation_id: correlationId }) : baseLog;
