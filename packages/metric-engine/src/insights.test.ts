import { describe, it, expect } from 'vitest';
import { computeInsights } from './insights.js';
import type { SilverPool, SilverConnection } from './silver-deps.js';

const BRAND = '33333333-3333-4333-8333-333333333333';

interface FakeTables {
  revenue?: Array<Record<string, unknown>>;
  driver?: Array<Record<string, unknown>>;
  exec?: Array<Record<string, unknown>>;
  churn?: Array<Record<string, unknown>>;
  vip?: Array<Record<string, unknown>>;
  cac?: Array<Record<string, unknown>>;
}

/** Fake StarRocks pool that routes each gold-mart query to the configured rows. */
function fakePool(t: FakeTables): SilverPool {
  const conn: SilverConnection = {
    async query(sql: string): Promise<[unknown, unknown]> {
      if (/^\s*SET\b/i.test(sql)) return [[], []];
      if (sql.includes('gold_revenue_ledger') && sql.includes('GROUP BY event_type')) return [t.driver ?? [], []];
      if (sql.includes('gold_revenue_ledger')) return [t.revenue ?? [], []];
      if (sql.includes('gold_executive_metrics')) return [t.exec ?? [], []];
      if (sql.includes("churn_risk = 'high'")) return [t.churn ?? [], []];
      if (sql.includes('monetary_score = 5')) return [t.vip ?? [], []];
      if (sql.includes('gold_cac')) return [t.cac ?? [], []];
      return [[], []];
    },
    release() {},
  };
  return { async query() { return [[], []]; }, async getConnection() { return conn; } };
}

describe('computeInsights — deterministic Insight + Opportunity Engine', () => {
  it('detects a revenue drop with driver, RTO leakage, and churn opportunity; ranks by severity then $', async () => {
    const pool = fakePool({
      revenue: [{ currency_code: 'INR', cur_minor: '82000', prior_minor: '100000' }],
      driver: [{ event_type: 'rto_reversal', cur_minor: '-5000', prior_minor: '0' }],
      exec: [{ currency_code: 'INR', realized_value_minor: '1000000', total_orders: '100', terminal_orders: '90', rto_orders: '18' }],
      churn: [{ currency_code: 'INR', high_risk_customers: '12', ltv_at_risk_minor: '870000' }],
    });

    const res = await computeInsights(BRAND, { srPool: pool });
    expect(res.hasData).toBe(true);
    expect(res.primaryCurrency).toBe('INR');

    const rev = res.insights.find((i) => i.detector === 'revenue_trend')!;
    expect(rev.kind).toBe('risk');
    expect(rev.severity).toBe('high'); // |18%| >= 15
    expect(rev.deltaPct).toBe('-18.00');
    expect(rev.impactMinor).toBe('18000');
    expect(rev.direction).toBe('down');
    expect(rev.evidence.top_driver_event).toBe('rto_reversal');

    const rto = res.insights.find((i) => i.detector === 'rto_leakage')!;
    expect(rto.severity).toBe('high'); // 20% RTO
    expect(rto.evidence.rto_rate_pct).toBe('20.00');
    expect(rto.impactMinor).toBe('180000'); // AOV 10000 × 18 RTO orders

    const churn = res.insights.find((i) => i.detector === 'churn_recovery')!;
    expect(churn.kind).toBe('opportunity');
    expect(churn.impactMinor).toBe('870000');

    // Ranking: all three are 'high'; highest money impact leads → churn (870k) > rto (180k) > revenue (18k).
    expect(res.insights[0]!.detector).toBe('churn_recovery');
  });

  it('is HONEST: returns no_data when every mart is empty (no fabricated insights)', async () => {
    const res = await computeInsights(BRAND, { srPool: fakePool({}) });
    expect(res.hasData).toBe(false);
    expect(res.insights).toHaveLength(0);
  });

  it('handles net-negative realized (severe returns): RTO rate reported, $-leak suppressed (no nonsense)', async () => {
    // Real-data edge case (brand "Bodd Active"): realized_value_minor < 0 → AOV is meaningless, so the
    // RTO RATE leads but impact_minor is null; and a non-positive prior base yields no % (direction only).
    const pool = fakePool({
      revenue: [{ currency_code: 'INR', cur_minor: '5000', prior_minor: '0' }],
      exec: [{ currency_code: 'INR', realized_value_minor: '-17107056', total_orders: '917', terminal_orders: '274', rto_orders: '103' }],
    });
    const res = await computeInsights(BRAND, { srPool: pool });

    const rto = res.insights.find((i) => i.detector === 'rto_leakage')!;
    expect(rto.evidence.rto_rate_pct).toBe('37.59'); // 103/274
    expect(rto.impactMinor).toBe(null); // no fabricated negative ₹-leak
    expect(rto.severity).toBe('high');

    const rev = res.insights.find((i) => i.detector === 'revenue_trend')!;
    expect(rev.deltaPct).toBe(null); // prior base ≤ 0 → no % quoted
    expect(rev.direction).toBe('up'); // 5000 > 0 swing
    expect(rev.title).not.toContain('%');
  });

  it('flags rising CAC month-over-month from exact integer operands', async () => {
    const pool = fakePool({
      cac: [
        { currency_code: 'INR', acquisition_month: '2026-06', spend_minor: '20000', new_customers: '4' },
        { currency_code: 'INR', acquisition_month: '2026-05', spend_minor: '10000', new_customers: '4' },
      ],
    });
    const res = await computeInsights(BRAND, { srPool: pool });
    const cac = res.insights.find((i) => i.detector === 'cac_trend')!;
    expect(cac.kind).toBe('risk');
    expect(cac.direction).toBe('up');
    expect(cac.deltaPct).toBe('100.00'); // 2500 → 5000 per new customer
  });

  it('suppresses the CAC insight when there is no ad spend (no meaningless 0/0 "CAC improving ?%")', async () => {
    const pool = fakePool({
      cac: [
        { currency_code: 'INR', acquisition_month: '2026-06', spend_minor: '0', new_customers: '40' },
        { currency_code: 'INR', acquisition_month: '2026-05', spend_minor: '0', new_customers: '30' },
      ],
    });
    const res = await computeInsights(BRAND, { srPool: pool });
    expect(res.insights.find((i) => i.detector === 'cac_trend')).toBeUndefined();
  });
});
