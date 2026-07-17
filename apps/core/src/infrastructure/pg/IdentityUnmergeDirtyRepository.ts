/**
 * ADR-0015 WS3 (identity in Silver) — PgIdentityUnmergeDirtyRepository (core side).
 *
 * The admin unmerge (merge-admin, A.2.4/WA-19) used to publish identity.unmerged.v1 to Kafka,
 * where stream-worker's RestitchDirtyConsumer / JourneyReversionDirtyConsumer turned the event
 * into dirty-queue rows. ADR-0015 removed those consumers — the Silver identity batch stage now
 * DRAINS the PG dirty queues directly — so nothing consumed the topic and an admin unmerge no
 * longer enqueued any downstream work. This repository closes that gap: core writes the SAME
 * rows the retired consumers would have written, straight into the two queues:
 *
 *   ops.restitch_pending          (PK brand_id, dirty_kind, dirty_key)
 *     unmerge → dirty_kind='brain_id' for {survivor, restored} (AMD-09: an unmerge wire event
 *     carried no identifier hashes — re-stitch is brain-grain), trigger_event='identity.unmerged'.
 *   ops.journey_reversion_pending (PK brand_id, brain_id)
 *     unmerge → {survivor, restored}, cause='unmerge', trigger_event='identity.unmerged'.
 *
 * The insert shape mirrors stream-worker's PgRestitchDirtyRepository / PgJourneyReversionDirtyRepository
 * verbatim (UNNEST batch + ON CONFLICT DO UPDATE provenance refresh) so re-running the same unmerge
 * is a no-op upsert. source_event_id = the merge_event_id being reversed (the stable audit handle the
 * reader returns/mints — the retired Kafka envelope's random event_id no longer exists); a missing/
 * malformed merge id falls back to a minted UUID so the causation column is never empty.
 *
 * GUARD (parity with the retired publisher): brand + restored + survivor must all be valid UUIDs or
 * nothing is written — the retired chain (publisher guard → consumers) produced rows ONLY for events
 * carrying a valid survivor, and without it the {survivor, restored} pair cannot be formed. The
 * durable SoR (Neo4j split + identity_audit) is already committed either way.
 *
 * TENANT ISOLATION: both tables are cross-brand trusted-ETL queues (NOT RLS-forced — like
 * ops.scoped_recompute_request); isolation is the explicit brand_id lead column on every row, so this
 * uses the raw brain_app pool, never the brand-GUC DbPool.
 *
 * FAIL-OPEN: a PG blip must NOT fail the user-facing unmerge (same contract the retired Kafka
 * publish had). Log and continue; the Silver identity stage still folds the change from
 * silver_identity_map on the next refresh.
 *
 * MONEY: none. Only brand/brain UUIDs, enum causes, and timestamps.
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';

/** Minimal logger shape (Fastify's pino instance satisfies this). */
export interface IdentityUnmergeDirtyLog {
  info(obj: Record<string, unknown>, msg?: string): void;
  warn(obj: Record<string, unknown>, msg?: string): void;
  error(obj: Record<string, unknown>, msg?: string): void;
}

export interface UnmergeDirtyEvent {
  brandId: string;
  /** The identity split back OUT (former absorbed id restored to independence). */
  restoredBrainId: string;
  /** The surviving canonical the absorbed id had been folded into (AMD-09 survivor). */
  survivorBrainId?: string;
  /** The ORIGINAL merge id this reversal undoes (source_event_id provenance). */
  mergeEventId?: string;
  actor: string;
  reason?: string;
  correlationId?: string;
}

/** The port the unmerge route wires: enqueue the restitch + journey-reversion work directly. */
export interface IdentityUnmergeDirtyWriter {
  markUnmerged(evt: UnmergeDirtyEvent): Promise<void>;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PgIdentityUnmergeDirtyRepository implements IdentityUnmergeDirtyWriter {
  /**
   * @param pool  raw pg.Pool connected as brain_app (main.ts rawPgPool — the ops queues are
   *              cross-brand trusted-ETL tables, no brand GUC).
   * @param log   structured logger (Fastify pino).
   */
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: IdentityUnmergeDirtyLog,
  ) {}

  async markUnmerged(evt: UnmergeDirtyEvent): Promise<void> {
    // Parity with the retired identity.unmerged.v1 publish guard: never enqueue a tenantless or
    // survivor-less pair (I-S01). The Neo4j split + PG audit are already durable — log and skip.
    if (
      !UUID_RE.test(evt.brandId) ||
      !UUID_RE.test(evt.restoredBrainId) ||
      !evt.survivorBrainId ||
      !UUID_RE.test(evt.survivorBrainId)
    ) {
      this.log.warn(
        { brand_id: evt.brandId, restored_brain_id: evt.restoredBrainId },
        '[core] unmerge dirty rows NOT enqueued — missing/invalid brand, restored or survivor id (split + audit already durable)',
      );
      return;
    }

    // source_event_id: the stable merge_event_id being reversed (the reader mints one for legacy
    // edges); minted fallback keeps the causation column populated if it is ever absent/malformed.
    const sourceEventId =
      evt.mergeEventId && UUID_RE.test(evt.mergeEventId) ? evt.mergeEventId : randomUUID();

    // Mirror of stream-worker's unmergedToDirty / unmergedToJourneyDirty: dirty {survivor, restored},
    // de-duplicated (a degenerate self-unmerge collapses to one entry; first occurrence wins).
    const brainIds = [...new Set([evt.survivorBrainId, evt.restoredBrainId])];
    const brandIds = brainIds.map(() => evt.brandId);
    const triggers = brainIds.map(() => 'identity.unmerged');
    const sourceIds = brainIds.map(() => sourceEventId);

    try {
      // ops.restitch_pending: brain_id-grain re-stitch keys (the unmerge event carries no identifier
      // hashes — AMD-09). Same UNNEST + ON CONFLICT upsert as stream-worker's PgRestitchDirtyRepository.
      await this.pool.query(
        `INSERT INTO ops.restitch_pending
           (brand_id, dirty_kind, dirty_key, trigger_event, source_event_id, enqueued_at)
         SELECT b::uuid, k, key, t, s, now()
         FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
           AS u(b, k, key, t, s)
         ON CONFLICT (brand_id, dirty_kind, dirty_key) DO UPDATE SET
           trigger_event   = EXCLUDED.trigger_event,
           source_event_id = EXCLUDED.source_event_id,
           enqueued_at     = EXCLUDED.enqueued_at`,
        [brandIds, brainIds.map(() => 'brain_id'), brainIds, triggers, sourceIds],
      );

      // ops.journey_reversion_pending: both brains rebuilt as N+1, cause='unmerge'. Same UNNEST +
      // ON CONFLICT upsert as stream-worker's PgJourneyReversionDirtyRepository.
      await this.pool.query(
        `INSERT INTO ops.journey_reversion_pending
           (brand_id, brain_id, cause, trigger_event, source_event_id, enqueued_at)
         SELECT b::uuid, br::uuid, c, t, s, now()
         FROM UNNEST($1::text[], $2::text[], $3::text[], $4::text[], $5::text[])
           AS u(b, br, c, t, s)
         ON CONFLICT (brand_id, brain_id) DO UPDATE SET
           cause           = EXCLUDED.cause,
           trigger_event   = EXCLUDED.trigger_event,
           source_event_id = EXCLUDED.source_event_id,
           enqueued_at     = EXCLUDED.enqueued_at`,
        [brandIds, brainIds, brainIds.map(() => 'unmerge'), triggers, sourceIds],
      );

      this.log.info(
        {
          brand_id: evt.brandId,
          restored_brain_id: evt.restoredBrainId,
          survivor_brain_id: evt.survivorBrainId,
          source_event_id: sourceEventId,
          correlation_id: evt.correlationId ?? 'system',
          dirty_brains: brainIds.length,
        },
        '[core] unmerge dirty rows enqueued (ops.restitch_pending + ops.journey_reversion_pending)',
      );
    } catch (err) {
      // FAIL-OPEN — the durable SoR (Neo4j split + PG audit) is intact; the Silver identity stage
      // folds the change from silver_identity_map on the next refresh.
      this.log.error(
        { brand_id: evt.brandId, restored_brain_id: evt.restoredBrainId, err },
        '[core] unmerge dirty enqueue failed (continuing — Neo4j/PG state is the SoR)',
      );
    }
  }
}
