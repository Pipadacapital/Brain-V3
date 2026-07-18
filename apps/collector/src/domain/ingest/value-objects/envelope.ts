/**
 * Envelope value-object — immutable stamped wrapper around a raw ingest body.
 * Stamping (received_at) is the ONLY transformation done in the request path.
 * All validation happens downstream (Connect → Bronze → Silver, ADR-0015).
 */
export interface IngestEnvelope {
  /** Raw body as received — no modification, no validation */
  readonly rawBody: Record<string, unknown>;
  /** ISO-8601 UTC timestamp when the collector received the HTTP body */
  readonly receivedAt: string;
}

export function stampEnvelope(rawBody: Record<string, unknown>): IngestEnvelope {
  return {
    rawBody,
    receivedAt: new Date().toISOString(),
  };
}
