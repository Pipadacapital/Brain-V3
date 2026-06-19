/**
 * Shared structured logger for the collector deployable. Import `{ log }` and use log.info/warn/error
 * instead of console.* — every line is JSON with the service field + NN-6 PII redaction, and
 * error-level logs forward the Error to Sentry when enabled. Request/job code may `log.child({...})`
 * to bind brand_id / correlation_id.
 */
import { createLogger } from '@brain/observability';

export const log = createLogger({ serviceName: 'collector' });
