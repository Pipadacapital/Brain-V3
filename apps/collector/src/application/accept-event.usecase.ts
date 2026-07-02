/**
 * AcceptEventUseCase — the ONLY use-case called in the HTTP request handler.
 *
 * D-1 INVARIANT (never bypass):
 *   1. Stamp received_at.
 *   2. INSERT into collector_spool (durable commit).
 *   3. Return. HTTP 200 is sent AFTER this function resolves.
 *
 * There is NO validation, NO Apicurio call, NO Kafka produce in this path.
 * All downstream processing is the drainer's responsibility.
 */
import { stampEnvelope } from '../domain/ingest/value-objects/envelope.js';
import type { SpoolRepository } from '../domain/ingest/repositories/spool.repository.js';

export interface AcceptResult {
  spoolId: bigint;
  receivedAt: string;
}

export interface AcceptManyResult {
  /** New spool row ids, in input order. */
  spoolIds: bigint[];
  receivedAt: string;
}

export class AcceptEventUseCase {
  constructor(private readonly spool: SpoolRepository) {}

  async execute(rawBody: Record<string, unknown>): Promise<AcceptResult> {
    // Step 1: stamp received_at (the only transformation allowed pre-ACK).
    const envelope = stampEnvelope(rawBody);

    // Step 2: INSERT INTO collector_spool — this commit IS the durability anchor.
    // If this throws, HTTP 500 is returned (spool unavailable); we do NOT ACK.
    // If this succeeds, the caller returns HTTP 200 immediately.
    const spoolId = await this.spool.insert(envelope);

    return { spoolId, receivedAt: envelope.receivedAt };
  }

  /**
   * Batch accept (/batch, AUD-PERF-007): same D-1 ordering, but ONE multi-row spool INSERT —
   * a single durable commit before the ACK instead of N sequential round-trips. No validation
   * here either: each event is spooled as-received and quarantined downstream if malformed.
   */
  async executeMany(rawBodies: Record<string, unknown>[]): Promise<AcceptManyResult> {
    const envelopes = rawBodies.map(stampEnvelope);
    const spoolIds = await this.spool.insertMany(envelopes);
    return { spoolIds, receivedAt: envelopes[envelopes.length - 1]?.receivedAt ?? '' };
  }
}
