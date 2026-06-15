/**
 * @brain/contracts — Zod-as-source-of-truth for all shared contracts.
 *
 * This package is the single source of truth for:
 *  - Event schemas (Avro wire format generated from these)
 *  - API request/response schemas (OpenAPI generated from these)
 *  - MCP tool input/output schemas
 *  - Data quality category declarations
 *
 * CODEOWNERS: /packages/contracts/ requires consuming-domain owner approval (I-E01).
 * No contract may be changed without a prior codegen run that commits the generated artifacts.
 */

// ── Events ────────────────────────────────────────────────────────────────────
export {
  CollectorEventV1Schema,
  COLLECTOR_EVENT_V1_TOPIC_SUFFIX,
  COLLECTOR_EVENT_V1_AVRO_SUBJECT,
} from './events/sample.collector.event.v1.js';
export type { CollectorEventV1 } from './events/sample.collector.event.v1.js';

// ── API contracts ─────────────────────────────────────────────────────────────
export {
  IngestEventHeadersSchema,
  IngestEventBodySchema,
  IngestEventRequestSchema,
  IngestEventAcceptedResponseSchema,
  ApiErrorResponseSchema,
  GetBrandEventCountInputSchema,
  GetBrandEventCountOutputSchema,
} from './api/sample.api.v1.js';
export type {
  IngestEventHeaders,
  IngestEventBody,
  IngestEventRequest,
  IngestEventAcceptedResponse,
  ApiErrorResponse,
  GetBrandEventCountInput,
  GetBrandEventCountOutput,
} from './api/sample.api.v1.js';

// ── Data quality declarations ─────────────────────────────────────────────────
export {
  DqFreshnessCheckSchema,
  DqCompletenessCheckSchema,
  DqSchemaValidityCheckSchema,
  DqReconciliationCheckSchema,
  DqCheckSchema,
} from './dq/index.js';
export type {
  DqFreshnessCheck,
  DqCompletenessCheck,
  DqSchemaValidityCheck,
  DqReconciliationCheck,
  DqCheck,
} from './dq/index.js';
