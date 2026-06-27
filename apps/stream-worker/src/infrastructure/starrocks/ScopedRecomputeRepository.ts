/**
 * StarRocksScopedRecomputeRepository — the concrete StarRocks (mysql2/promise) adapter
 * for the IScopedRecomputeRepository port.
 *
 * Writes to brain_ops.scoped_recompute_request using the StarRocks PRIMARY KEY table's
 * "INSERT == upsert by PK" semantics — re-inserting the same (brand_id, request_id)
 * is a no-op (the existing row is overwritten with identical data). This is the idempotency
 * guarantee that makes the consumer retry-safe without an explicit ON CONFLICT clause.
 *
 * PATTERN: mirrors the identity-export job (apps/stream-worker/src/jobs/identity-export/run.ts)
 * which uses mysql2/promise to UPSERT into brain_ops.silver_identity_link. Same JDBC/mysql
 * protocol over port 9030 (StarRocks query port).
 *
 * TENANT ISOLATION: brand_id is the PRIMARY KEY lead column and the DISTRIBUTED BY hash
 * key in brain_ops.scoped_recompute_request (see db/starrocks/ops/ops_scoped_recompute_request.sql).
 * Every INSERT row carries brand_id at position 1 — the V4 tenant-key invariant.
 *
 * MONEY: no money in ScopedRecompute; no money columns written here. The table holds
 * opaque UUIDs and JSON arrays of mart names.
 *
 * DDL: db/starrocks/ops/ops_scoped_recompute_request.sql
 * Applied by: db/starrocks/ops/run_ops.sh
 */
import type mysql from 'mysql2/promise';
import type { ScopedRecompute } from '../../domain/identity/ScopedRecompute.js';
import type { IScopedRecomputeRepository } from '../../interfaces/consumers/IdentityChangeRecomputeConsumer.js';

/** ISO-8601 UTC → StarRocks DATETIME string (YYYY-MM-DD HH:MM:SS). */
const toSrDatetime = (iso: string): string =>
  new Date(iso).toISOString().slice(0, 19).replace('T', ' ');

export class StarRocksScopedRecomputeRepository implements IScopedRecomputeRepository {
  /**
   * @param pool  mysql2/promise Pool connected to StarRocks (mysql protocol, port 9030).
   *              The pool is created + managed by the consumer's start() wiring (main.ts).
   *              See identity-export/run.ts for the pool creation pattern.
   */
  constructor(private readonly pool: mysql.Pool) {}

  /**
   * Idempotent upsert into brain_ops.scoped_recompute_request.
   * StarRocks PRIMARY KEY table: INSERT on a duplicate PK overwrites the existing row —
   * safe to re-run with the same (brand_id, request_id) on consumer retry.
   */
  async upsert(recompute: ScopedRecompute): Promise<void> {
    await this.pool.query(
      `INSERT INTO brain_ops.scoped_recompute_request
         (brand_id, request_id, source_event_id, trigger_event,
          brain_ids, affected_marts, requested_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        recompute.brand_id,
        recompute.request_id,
        recompute.source_event_id,
        recompute.trigger_event,
        JSON.stringify(recompute.affected_brain_ids),
        JSON.stringify(Array.from(recompute.affected_marts)),
        toSrDatetime(recompute.requested_at),
      ],
    );
  }
}
