/**
 * sample.api.v1 — Zod contract for the canonical collector ingest API endpoint.
 *
 * POST /v1/events
 *
 * INVARIANTS:
 *  - Idempotency-Key header is REQUIRED for all write operations (I-ST04).
 *  - brand_id must be extracted from the authenticated JWT — never from the body.
 *  - Response carries request_id for error correlation (ADR-009).
 *
 * This contract is SOURCE OF TRUTH; the OpenAPI spec is generated from it (I-E01).
 */
import { z } from 'zod';

// ── Request headers ──────────────────────────────────────────────────────────

export const IngestEventHeadersSchema = z.object({
  /**
   * Client-supplied idempotency key (UUID). The collector uses this to de-duplicate
   * duplicate HTTP deliveries before spooling (I-ST04).
   * Must be unique per logical operation; clients should persist and retry with the SAME key.
   */
  'idempotency-key': z.string().uuid(),

  /**
   * W3C traceparent header — propagated to Kafka and Bronze as correlation_id.
   * Optional at the HTTP layer; the collector synthesises one if absent.
   */
  traceparent: z.string().optional(),
});

export type IngestEventHeaders = z.infer<typeof IngestEventHeadersSchema>;

// ── Request body ─────────────────────────────────────────────────────────────

export const IngestEventBodySchema = z.object({
  /**
   * Event name (dot-separated, lowercase).
   * Examples: "page.viewed", "order.placed", "cart.abandoned".
   */
  event_name: z.string().min(1).max(128),

  /**
   * ISO-8601 timestamp (UTC) of when the event occurred at the source.
   */
  occurred_at: z.string().datetime({ offset: false }),

  /**
   * Hashed identifier for the end-user (sha256(per-brand-salt || normalized_id)).
   * Raw email/phone MUST NOT be sent here (I-S02).
   */
  hashed_user_id: z.string().max(64).optional(),

  /**
   * Hashed session identifier (sha256(per-brand-salt || session_id)).
   */
  hashed_session_id: z.string().max(64).optional(),

  /**
   * Arbitrary event properties. No raw PII allowed (I-S02).
   */
  properties: z.record(z.string(), z.unknown()).optional().default({}),
});

export type IngestEventBody = z.infer<typeof IngestEventBodySchema>;

// ── Request (combined) ───────────────────────────────────────────────────────

export const IngestEventRequestSchema = z.object({
  headers: IngestEventHeadersSchema,
  body: IngestEventBodySchema,
});

export type IngestEventRequest = z.infer<typeof IngestEventRequestSchema>;

// ── Responses ─────────────────────────────────────────────────────────────────

/** 202 Accepted — event spooled, not yet validated or produced to Kafka. */
export const IngestEventAcceptedResponseSchema = z.object({
  /** Unique request ID for error correlation — always present on responses (ADR-009). */
  request_id: z.string().uuid(),

  /** The event_id the collector assigned to this event. */
  event_id: z.string().uuid(),

  /** Status is always "accepted" on 202 — not "processed". */
  status: z.literal('accepted'),
});

export type IngestEventAcceptedResponse = z.infer<typeof IngestEventAcceptedResponseSchema>;

/** 4xx / 5xx error response — always carries request_id for trace correlation (ADR-009). */
export const ApiErrorResponseSchema = z.object({
  request_id: z.string().uuid(),
  error: z.object({
    code: z.string(),
    message: z.string(),
    /**
     * Field-level validation errors (populated on 422 Unprocessable Entity).
     */
    fields: z
      .array(
        z.object({
          field: z.string(),
          message: z.string(),
        }),
      )
      .optional(),
  }),
});

export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;

// ── MCP Tool schema (read-only analytics retrieval — I-S08) ─────────────────

/**
 * Sample MCP tool: get_brand_event_count
 * Read-only — no write tools may be registered on the MCP server (I-S08).
 */
export const GetBrandEventCountInputSchema = z.object({
  brand_id: z.string().uuid().describe('The brand to query (must match authenticated brand).'),
  event_name: z.string().min(1).max(128).describe('Event name to count.'),
  from_date: z.string().datetime({ offset: false }).describe('Window start (UTC ISO-8601).'),
  to_date: z.string().datetime({ offset: false }).describe('Window end (UTC ISO-8601).'),
});

export const GetBrandEventCountOutputSchema = z.object({
  brand_id: z.string().uuid(),
  event_name: z.string(),
  count: z.number().int().nonnegative(),
  /** The metric_version this count was computed against. */
  metric_version: z.number().int().positive(),
  /** Snapshot ID for parity-oracle verification (I-E04). */
  snapshot_id: z.string().uuid(),
});

export type GetBrandEventCountInput = z.infer<typeof GetBrandEventCountInputSchema>;
export type GetBrandEventCountOutput = z.infer<typeof GetBrandEventCountOutputSchema>;
