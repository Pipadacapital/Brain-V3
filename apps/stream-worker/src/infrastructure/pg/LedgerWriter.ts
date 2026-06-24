/**
 * LedgerWriter — stream-worker side ad-spend ledger feed (feat-ad-connectors / ADR-AD-6).
 *
 * MEDALLION REALIGNMENT (Epic 1 / decision B): all realized_revenue_ledger writes
 * (provisional_recognition, reversals, refunds, COD delivery/RTO, settlement net-of-fees, fee lines)
 * have been REMOVED from this class. The revenue recognition ledger is now built FROM Bronze by dbt
 * (silver_order_recognition → brain_gold.gold_revenue_ledger, `make recognition-refresh`) — no PG
 * write path. What remains is the ad_spend_ledger writer (the marketing-spend fact), which is OUT of
 * Epic-1 scope (a separate operational PG money ledger feeding the gold spend marts).
 *
 * Money: spend_minor stays BIGINT-as-string throughout (I-S07).
 * Restatement-safe: ON CONFLICT (brand_id, platform, level, level_id, stat_date) DO UPDATE the
 * mutable measures (spend_minor/currency_code, impressions, clicks, occurred_at) — ad platforms
 * RESTATE a stat_date for 72h+, so a corrected re-pull must overwrite the stale row, not be dropped
 * (PF-9). The UPDATE is guarded to only fire when a value actually changed, so re-applying identical
 * values is a no-op → still idempotent/replay-safe (I-ST04).
 * All writes under brain_app + set_config GUC per brand (NN-1 / RLS).
 */

import { Pool, PoolClient } from 'pg';
import { log } from '../../log.js';

export class LedgerWriter {
  private readonly pool: Pool;

  constructor(connectionString: string) {
    this.pool = new Pool({
      connectionString,
      max: 3,
      idleTimeoutMillis: 30_000,
      statement_timeout: 15_000,
    });
  }

  // ── ad_spend_ledger (feat-ad-connectors / ADR-AD-6) ────────────────────────
  //   - ON CONFLICT (brand_id, platform, level, level_id, stat_date) DO UPDATE the mutable
  //     measures (PF-9 — ad platforms restate a stat_date for 72h+; a corrected re-pull must
  //     overwrite the stale row, not be silently dropped, or ROAS goes wrong). The UPDATE is
  //     guarded so identical values are a no-op → idempotent/replay-safe (I-ST04).
  //   - spend_minor is BIGINT-as-string (I-S07 — no parseFloat anywhere upstream); currency_code
  //     is restated alongside spend_minor so the amount/currency pair stays intact.
  //   - Append-only is now insert-or-restate by GRANT (brain_app: SELECT+INSERT+UPDATE on
  //     ad_spend_ledger).

  /**
   * Write an ad_spend_ledger row. Idempotent on the dedup key; a re-pull with restated values
   * overwrites the existing row (PF-9), while an identical re-pull is a no-op.
   * Returns true if the row was inserted or its measures changed, false if nothing changed.
   */
  async writeAdSpend(params: {
    brandId: string;
    spendEventId: string;       // ADR-AD-5 deterministic id (= raw_event_id / Bronze event_id)
    platform: 'meta' | 'google_ads';
    level: 'campaign' | 'adset' | 'ad' | 'creative';
    levelId: string;
    parentId: string | null;
    campaignId: string | null;
    campaignName: string | null;
    statDate: string;           // YYYY-MM-DD (click-date anchored, canonical)
    spendMinor: string;         // BIGINT-as-string (I-S07)
    currencyCode: string;
    impressions: string | null; // BIGINT-as-string
    clicks: string | null;      // BIGINT-as-string
    conversionsRaw: Record<string, unknown> | null;  // RAW (ADR-AD-8)
    accountTimezone: string | null;
    rawEventId: string;         // Bronze provenance (= spendEventId)
    occurredAt: string;         // ISO-8601
  }): Promise<boolean> {
    const client: PoolClient = await this.pool.connect();
    try {
      await client.query('BEGIN');

      // GUC-first: brand context required for RLS (NN-1)
      await client.query(
        "SELECT set_config('app.current_brand_id', $1, true)",
        [params.brandId],
      );

      const result = await client.query<{ spend_event_id: string }>(
        `INSERT INTO ad_spend_ledger (
          brand_id, spend_event_id, platform, level, level_id, parent_id,
          campaign_id, campaign_name, stat_date, spend_minor, currency_code,
          impressions, clicks, conversions_raw, account_timezone, raw_event_id, occurred_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6,
          $7, $8, $9::date, $10::bigint, $11,
          $12::bigint, $13::bigint, $14::jsonb, $15, $16, $17
        )
        ON CONFLICT (brand_id, platform, level, level_id, stat_date)
        DO UPDATE SET
          spend_minor   = EXCLUDED.spend_minor,
          currency_code = EXCLUDED.currency_code,
          impressions   = EXCLUDED.impressions,
          clicks        = EXCLUDED.clicks,
          occurred_at   = EXCLUDED.occurred_at
        WHERE ad_spend_ledger.spend_minor   IS DISTINCT FROM EXCLUDED.spend_minor
           OR ad_spend_ledger.currency_code IS DISTINCT FROM EXCLUDED.currency_code
           OR ad_spend_ledger.impressions   IS DISTINCT FROM EXCLUDED.impressions
           OR ad_spend_ledger.clicks        IS DISTINCT FROM EXCLUDED.clicks
           OR ad_spend_ledger.occurred_at   IS DISTINCT FROM EXCLUDED.occurred_at
        RETURNING spend_event_id`,
        [
          params.brandId,
          params.spendEventId,
          params.platform,
          params.level,
          params.levelId,
          params.parentId,
          params.campaignId,
          params.campaignName,
          params.statDate,
          params.spendMinor,
          params.currencyCode,
          params.impressions,
          params.clicks,
          params.conversionsRaw ? JSON.stringify(params.conversionsRaw) : null,
          params.accountTimezone,
          params.rawEventId,
          params.occurredAt,
        ],
      );

      await client.query('COMMIT');

      // rowCount > 0 ⇒ inserted OR restated (guarded DO UPDATE fired); 0 ⇒ identical re-pull (no-op).
      const written = (result.rowCount ?? 0) > 0;
      if (written) {
        log.info(`[ledger-writer] ad_spend brand=${params.brandId} platform=${params.platform} ` +
                    `level=${params.level} level_id=${params.levelId} stat_date=${params.statDate} ` +
                    `spend=${params.spendMinor} ${params.currencyCode}`);
      }
      return written;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw err;
    } finally {
      client.release();
    }
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}
