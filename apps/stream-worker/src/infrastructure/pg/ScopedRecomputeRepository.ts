/**
 * PgScopedRecomputeRepository — the concrete PostgreSQL (pg) adapter for the
 * IScopedRecomputeRepository port.
 *
 * Writes to ops.scoped_recompute_request (PG `ops` schema — V4 StarRocks REMOVAL, migration 0116;
 * PG is the SOLE operational store). Idempotency is an explicit
 *   INSERT ... ON CONFLICT (brand_id, request_id) DO UPDATE
 * — re-delivering the same Kafka identity event yields the same deterministic request_id, so a retry
 * overwrites the existing row with identical data (no duplicate queue entry). This replaces the prior
 * StarRocks PRIMARY-KEY-table "INSERT == upsert" semantics with the PG-idiomatic conflict clause.
 *
 * TENANT ISOLATION: brand_id is the PRIMARY KEY lead column of ops.scoped_recompute_request
 * (db/migrations/0116_brain_ops_to_pg.sql) — the V4 tenant-key invariant. Every INSERT row carries
 * brand_id at position 1. The table is NOT RLS-forced (cross-brand trusted ETL home — the worker runs
 * as brain_app with no brand GUC); isolation is the explicit brand_id on every row/read.
 *
 * MONEY: no money in ScopedRecompute; no money columns written here. The table holds opaque UUIDs
 * and JSON arrays of mart names.
 *
 * DDL: db/migrations/0116_brain_ops_to_pg.sql (ops.scoped_recompute_request).
 */
import type pg from 'pg';
import type { ScopedRecompute, IScopedRecomputeRepository } from '../../domain/identity/ScopedRecompute.js';

export class PgScopedRecomputeRepository implements IScopedRecomputeRepository {
  /**
   * @param pool  pg.Pool connected to PostgreSQL as brain_app (the worker's dbUrl pool).
   *              The pool is created + managed by the consumer's start() wiring (main.ts).
   */
  constructor(private readonly pool: pg.Pool) {}

  /**
   * Idempotent upsert into ops.scoped_recompute_request.
   * ON CONFLICT (brand_id, request_id) DO UPDATE — safe to re-run with the same
   * (brand_id, request_id) on consumer retry. jsonb columns accept the JSON text directly.
   */
  async upsert(recompute: ScopedRecompute): Promise<void> {
    await this.pool.query(
      `INSERT INTO ops.scoped_recompute_request
         (brand_id, request_id, source_event_id, trigger_event,
          brain_ids, affected_marts, requested_at)
       VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb, $7)
       ON CONFLICT (brand_id, request_id) DO UPDATE SET
         source_event_id = EXCLUDED.source_event_id,
         trigger_event   = EXCLUDED.trigger_event,
         brain_ids       = EXCLUDED.brain_ids,
         affected_marts  = EXCLUDED.affected_marts,
         requested_at    = EXCLUDED.requested_at`,
      [
        recompute.brand_id,
        recompute.request_id,
        recompute.source_event_id,
        recompute.trigger_event,
        JSON.stringify(recompute.affected_brain_ids),
        JSON.stringify(Array.from(recompute.affected_marts)),
        recompute.requested_at,
      ],
    );
  }
}
