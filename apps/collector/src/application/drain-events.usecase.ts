/**
 * DrainEventsUseCase — reads pending spool rows and produces to Redpanda.
 *
 * Called by the drainer loop (interfaces/jobs/drainer.ts), NEVER by the HTTP handler.
 *
 * D-1 / F-3 invariants:
 *   - On Kafka produce error: leave row as 'pending', log, do NOT throw up to caller.
 *     The drainer loop calls this; a throw would crash the loop.
 *   - On produce success: mark row 'drained'.
 *   - Back-pressure: if Redpanda is down, the whole batch silently stays pending.
 *     Next drainer tick will retry. No event is dropped.
 *
 * ADR-0012 ingest dedup gate (pixel/collector path):
 *   Before producing, the batch's keyable entries (BOTH brand_id AND event_id present) are checked
 *   against data_plane.ingest_dedup via the 0130 cross-brand SECURITY DEFINER helpers. Already-seen
 *   ids are DROPPED (not re-produced) but still marked drained; unseen ids are produced. Entries
 *   missing a brand_id or event_id CANNOT be keyed → they are NEVER deduped and always produced
 *   as-is (rare/malformed; Silver handles them). ORDER IS CRITICAL: produce FIRST, then
 *   markEventsSeen + markDrained inside the claim's commit — a crash between at worst re-produces a
 *   dup on the next drain (Silver backstops), it NEVER loses an event.
 *
 * Returns the count of rows drained in this batch (seen dups ARE drained, just not produced).
 */
import type { SpoolRepository } from '../domain/ingest/repositories/spool.repository.js';
import type { CollectorKafkaProducer } from '../infrastructure/kafka-producer.js';
import type { DedupPair, filterUnseenEventIds, markEventsSeen } from '../infrastructure/ingest-dedup.repository.js';
import { incrementCounter } from '@brain/observability';
import { log } from "../log.js";

/**
 * The two ingest-dedup helpers, injected so the composition root wires the real
 * data_plane.filter_unseen_events / mark_events_seen calls and tests can stub them.
 */
export interface IngestDedup {
  filterUnseenEventIds: typeof filterUnseenEventIds;
  markEventsSeen: typeof markEventsSeen;
}

export class DrainEventsUseCase {
  constructor(
    private readonly spool: SpoolRepository,
    private readonly kafka: CollectorKafkaProducer,
    private readonly batchSize: number,
    private readonly dedup: IngestDedup,
  ) {}

  async execute(): Promise<number> {
    // Row-claim (AUD-PERF-006): the claimed rows are locked (FOR UPDATE SKIP LOCKED) for the
    // duration of this pass, so an overlapping tick / second replica skips them (no double-produce).
    const claim = await this.spool.claimPending(this.batchSize);
    if (claim.entries.length === 0) {
      await claim.rollback();
      return 0;
    }

    // AUD-PERF-012: the body is the CANONICAL jsonb text straight from PG; correlation_id /
    // brand_id / event_id were projected in SQL — no JSON parse or stringify on this path.
    const batch = claim.entries.map((entry) => ({
      valueText: entry.rawBodyText,
      brandId: entry.brandId,
      eventId: entry.eventId,
      correlationId: entry.correlationId ?? `spool-${entry.id.toString()}`,
    }));

    // ADR-0012 dedup partition. An entry is KEYABLE only when it has BOTH a brand_id and an event_id
    // — those are the only rows we can index in ingest_dedup. Entries missing either CANNOT be keyed
    // and MUST NOT be deduped: they always produce as-is (Silver handles the malformed tail).
    const keyablePairs: DedupPair[] = [];
    for (const entry of batch) {
      if (entry.brandId !== null && entry.eventId !== null) {
        keyablePairs.push({ brandId: entry.brandId, eventId: entry.eventId });
      }
    }

    let toProduce = batch;
    let producedKeyablePairs: DedupPair[] = keyablePairs;
    let dropped = 0;

    if (keyablePairs.length > 0) {
      let unseen: Set<string>;
      try {
        // Read on the claim's client so the whole gate stays in one connection/txn.
        unseen = await this.dedup.filterUnseenEventIds(claim.client, keyablePairs);
      } catch (err) {
        // A dedup-read failure must NOT lose events. Release the claim (every row stays 'pending')
        // and let the next drainer tick retry — identical to the markDrained-infra failure path.
        log.error('ingest dedup filter failed — leaving spool batch pending (no event loss)', {
          err,
          batch_size: claim.entries.length,
          first_spool_id: claim.entries[0]?.id.toString(),
        });
        await claim.rollback().catch(() => undefined);
        return 0;
      }

      // Produce = (null-keyed entries, always) ∪ (keyable entries whose event_id is unseen).
      // Dropped = keyable entries whose event_id was already ingested.
      toProduce = batch.filter(
        (entry) =>
          entry.brandId === null ||
          entry.eventId === null ||
          unseen.has(entry.eventId),
      );
      producedKeyablePairs = keyablePairs.filter((p) => unseen.has(p.eventId));
      dropped = keyablePairs.length - producedKeyablePairs.length;
    }

    if (toProduce.length > 0) {
      try {
        // ONE producer.send for the whole batch (AUD-PERF-002) — kafkajs batches the messages
        // natively; per-message correlation_id/trace headers are built by the producer.
        await this.kafka.produceBatch(toProduce);
      } catch (err) {
        // F-3 back-pressure: leave the WHOLE batch 'pending'. Redpanda may be down.
        // Log the error but do NOT throw — the drainer loop must continue to next tick.
        // Pass the Error in fields.err so Sentry + stack handling fires (not a stringified message).
        // NOTHING is marked (neither seen nor drained) — the claim is rolled back below.
        log.error('batch produce failed — leaving spool batch pending (back-pressure)', {
          err,
          batch_size: claim.entries.length,
          first_spool_id: claim.entries[0]?.id.toString(),
        });
        await claim.rollback().catch(() => undefined);
        return 0;
      }
    }

    try {
      // ORDER IS CRITICAL (ADR-0012): produce ALREADY happened above; now mark-seen + mark-drained
      // in the SAME claim transaction and commit together. markEventsSeen records ONLY the ids we
      // actually produced; markDrained drains ALL claimed ids (incl. the dropped dups — they're done,
      // just not re-produced). A crash before commit → nothing durable → re-drain re-produces a dup.
      await this.dedup.markEventsSeen(claim.client, producedKeyablePairs);
      await claim.markDrained(claim.entries.map((entry) => entry.id));
      await claim.commit();
    } catch (err) {
      // Claim-settle / markDrained / mark-seen infrastructure error: release the claim so every row
      // stays 'pending' (no event loss; the re-produce next tick is absorbed by ingest_dedup on
      // re-drain — mark-seen didn't commit, so filter re-drops the already-produced ids only if a
      // prior commit landed them, else Silver's per-lane dedup backstops).
      await claim.rollback().catch(() => undefined);
      throw err;
    }

    if (dropped > 0) {
      // Count + surface the dropped duplicates (pixel source label distinguishes from connector path).
      incrementCounter('ingest_dedup_dropped_total', { source: 'pixel' });
      log.info('ingest dedup: dropped already-ingested events', {
        dropped,
        produced: toProduce.length,
        batch_size: claim.entries.length,
      });
    }

    // Rows drained this batch = every claimed row (dropped dups are drained too, just not produced).
    return claim.entries.length;
  }
}
