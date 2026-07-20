/**
 * get-medallion-journey.test.ts — unit tests for the V4 "medallion journey" pipeline-observability read.
 *
 * The read composes CHEAP-metadata probes across the medallion tiers (Bronze → Silver → Identity/Neo4j
 * → Gold → Serving). FRESHNESS + STATE for every tier now come from the tiny silver_job_watermark
 * side-table (read ONCE), while row counts are best-effort count-only probes that never gate state.
 * These tests script a fake serving pool (answering the watermark read + each tier's count-only probe
 * by SQL shape) + a stubbed Neo4j counts port, and assert:
 *   • the full contract shape (all five tiers present, well-formed);
 *   • the Gold partition — mv_gold_customer_360 → customer360, other mv_gold_* → biMarts;
 *   • the Serving tier reuses getServingFreshness's per-mart output verbatim;
 *   • fail-soft on a DEAD serving tier (every serving probe errors → nulls + state no_data, NO throw);
 *   • fail-soft on UNREACHABLE Neo4j (port throws → reachable:false, nulls, NO throw).
 * No live DB / no live Neo4j.
 */

import { describe, it, expect } from 'vitest';
import type { SilverPool } from '@brain/metric-engine';
import {
  getMedallionJourney,
  type Neo4jPipelineCounts,
} from '../internal/application/queries/get-medallion-journey.js';

const recentIso = (minsAgo = 5): string => new Date(Date.now() - minsAgo * 60_000).toISOString();

/** Marts the freshness enumerate/probe returns: customer_360 + two BI marts. */
const GOLD_MARTS = ['mv_gold_customer_360', 'mv_gold_revenue_ledger', 'mv_gold_funnel'];

/**
 * A fake serving SilverPool. Routes each .query by SQL shape to the right canned answer:
 *   • information_schema.columns (getServingFreshness enumerate) → the serving view list;
 *   • the UNION-ALL freshness probe (getServingFreshness) → per-mart aggregates;
 *   • silver_job_watermark → the FULL watermark side-table (one row per job — the freshness+state
 *     source for EVERY tier: keystone/Bronze, order-state, marketing-spend, and the gold-* jobs);
 *   • brain_bronze.collector_events_connect → Bronze best-effort count-only;
 *   • a brain_serving."mv_silver_*" single-view probe → that Silver mart's best-effort count-only.
 * `dead: true` makes EVERY query throw (fail-soft dead-tier path).
 */
function fakeSr(opts: { dead?: boolean } = {}): SilverPool {
  return {
    async query(sql: string): Promise<unknown[]> {
      if (opts.dead) throw new Error('duckdb-serving unreachable (504)');

      if (sql.includes('silver_job_watermark')) {
        // The whole tiny side-table: one row per transform job (silver + gold). This is the
        // freshness/state source for every tier.
        return [
          { job_name: 'silver-collector-event', last_ingested_at: recentIso(3), updated_at: recentIso(2) },
          { job_name: 'silver-order-state', last_ingested_at: recentIso(4), updated_at: recentIso(3) },
          { job_name: 'silver-marketing-spend', last_ingested_at: recentIso(4), updated_at: recentIso(3) },
          { job_name: 'gold-customer-360', last_ingested_at: recentIso(5), updated_at: recentIso(4) },
          { job_name: 'gold-revenue-ledger', last_ingested_at: recentIso(5), updated_at: recentIso(4) },
          { job_name: 'gold-funnel', last_ingested_at: recentIso(6), updated_at: recentIso(5) },
        ];
      }
      if (sql.includes('information_schema.columns')) {
        // getServingFreshness enumerate: every serving view that carries updated_at.
        return GOLD_MARTS.map((table_name) => ({ table_name }));
      }
      if (sql.includes('UNION ALL')) {
        // getServingFreshness UNION-ALL probe: one row per mart.
        return GOLD_MARTS.map((mv, i) => ({
          mv,
          last_refresh_at: recentIso(5),
          row_count: String(100 + i),
        }));
      }
      if (sql.includes('brain_bronze') && sql.includes('collector_events_connect')) {
        return [{ row_count: '5000' }];
      }
      if (sql.includes('mv_silver_collector_event')) {
        return [{ row_count: '4000' }];
      }
      if (sql.includes('mv_silver_order_state')) {
        return [{ row_count: '900' }];
      }
      if (sql.includes('mv_silver_marketing_spend')) {
        return [{ row_count: '300' }];
      }
      return [];
    },
    async getConnection() {
      throw new Error('not used — getMedallionJourney reads metadata via .query');
    },
  } as unknown as SilverPool;
}

/** A Neo4j counts port that returns fixed counts. */
const okNeo4j: Neo4jPipelineCounts = {
  async readCounts() {
    return { brainIds: 250, identifiers: 700, edges: 900 };
  },
};

/** A Neo4j counts port that throws (unreachable). */
const deadNeo4j: Neo4jPipelineCounts = {
  async readCounts() {
    throw new Error('Neo4j connection refused');
  },
};

describe('getMedallionJourney', () => {
  it('returns the full contract shape across all five tiers (healthy path)', async () => {
    const res = await getMedallionJourney({ srPool: fakeSr(), neo4jCounts: okNeo4j });

    expect(typeof res.generatedAt).toBe('string');
    expect(new Date(res.generatedAt).toString()).not.toBe('Invalid Date');

    // Bronze
    expect(res.bronze.table).toBe('collector_events_connect');
    expect(res.bronze.rowCount).toBe(5000);
    expect(typeof res.bronze.latestEventAt).toBe('string');
    expect(res.bronze.state).toBe('fresh');

    // Silver: three marts + watermark
    expect(res.silver.keystone.rowCount).toBe(4000);
    expect(res.silver.orderState.rowCount).toBe(900);
    expect(res.silver.marketingSpend.rowCount).toBe(300);
    expect(typeof res.silver.watermark.lastIngestedAt).toBe('string');
    expect(res.silver.watermark.lagSeconds).not.toBeNull();
    expect(res.silver.watermark.lagSeconds).toBeGreaterThanOrEqual(0);
    expect(res.silver.state).toBe('fresh');

    // Identity
    expect(res.identity).toEqual({
      reachable: true,
      brainIds: 250,
      identifiers: 700,
      edges: 900,
      state: 'fresh',
    });
  });

  it('partitions gold marts: customer_360 vs biMarts', async () => {
    const res = await getMedallionJourney({ srPool: fakeSr(), neo4jCounts: okNeo4j });

    // customer_360 is the 360 mart, extracted from the mart set.
    expect(res.gold.customer360.table).toBe('mv_gold_customer_360');
    expect(res.gold.customer360.rowCount).toBe(100); // GOLD_MARTS[0] → 100
    expect(res.gold.customer360.freshnessAt).not.toBeNull();

    // biMarts = every OTHER mv_gold_* (customer_360 excluded).
    const biNames = res.gold.biMarts.map((m) => m.name);
    expect(biNames).toContain('mv_gold_revenue_ledger');
    expect(biNames).toContain('mv_gold_funnel');
    expect(biNames).not.toContain('mv_gold_customer_360');
    expect(res.gold.biMarts.every((m) => typeof m.rowCount === 'number')).toBe(true);
    expect(res.gold.state).toBe('fresh');

    // Serving tier reuses getServingFreshness's per-mart output verbatim (all marts, freshness state).
    expect(res.serving.marts.map((m) => m.view).sort()).toEqual([...GOLD_MARTS].sort());
    expect(res.serving.marts.every((m) => m.state === 'fresh')).toBe(true);
    expect(res.serving.state).toBe('fresh');
  });

  it('fail-soft on a DEAD serving tier: nulls + no_data everywhere, never throws', async () => {
    const res = await getMedallionJourney({ srPool: fakeSr({ dead: true }), neo4jCounts: okNeo4j });

    expect(res.bronze.rowCount).toBeNull();
    expect(res.bronze.latestEventAt).toBeNull();
    expect(res.bronze.state).toBe('no_data');

    expect(res.silver.keystone.rowCount).toBeNull();
    expect(res.silver.orderState.rowCount).toBeNull();
    expect(res.silver.marketingSpend.rowCount).toBeNull();
    expect(res.silver.watermark.lastIngestedAt).toBeNull();
    expect(res.silver.watermark.lagSeconds).toBeNull();
    expect(res.silver.state).toBe('no_data');

    expect(res.gold.customer360.rowCount).toBeNull();
    expect(res.gold.biMarts).toEqual([]);
    expect(res.gold.state).toBe('no_data');

    expect(res.serving.marts).toEqual([]);
    expect(res.serving.state).toBe('no_data');

    // Identity tier is INDEPENDENT of the serving tier — Neo4j still answered.
    expect(res.identity.reachable).toBe(true);
    expect(res.identity.brainIds).toBe(250);
  });

  it('fail-soft on UNREACHABLE Neo4j: reachable:false + nulls, never throws', async () => {
    const res = await getMedallionJourney({ srPool: fakeSr(), neo4jCounts: deadNeo4j });

    expect(res.identity).toEqual({
      reachable: false,
      brainIds: null,
      identifiers: null,
      edges: null,
      state: 'no_data',
    });
    // The rest of the pipeline is unaffected by the dead identity tier.
    expect(res.bronze.state).toBe('fresh');
    expect(res.serving.state).toBe('fresh');
  });

  it('absent srPool + absent Neo4j → fully honest no_data (never throws)', async () => {
    const res = await getMedallionJourney({});
    expect(res.bronze.state).toBe('no_data');
    expect(res.silver.state).toBe('no_data');
    expect(res.gold.state).toBe('no_data');
    expect(res.serving.state).toBe('no_data');
    expect(res.identity.reachable).toBe(false);
    expect(res.identity.state).toBe('no_data');
  });
});
