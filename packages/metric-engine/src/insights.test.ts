import { describe, it, expect } from 'vitest';
import { computeInsights } from './insights.js';
import type { SilverPool } from './silver-deps.js';

const BRAND = '33333333-3333-4333-8333-333333333333';

interface FakeTables {
  // Revenue rows are now per (currency_code, event_type): the revenue swing + its top-driver
  // breakdown are read in ONE folded `GROUP BY currency_code, event_type` query (perf — no separate
  // dependent driver round-trip), and per-currency totals are re-aggregated in-memory.
  revenue?: Array<Record<string, unknown>>;
  exec?: Array<Record<string, unknown>>;
  churn?: Array<Record<string, unknown>>;
  vip?: Array<Record<string, unknown>>;
  cac?: Array<Record<string, unknown>>;
  spend?: Array<Record<string, unknown>>;
  funnel?: Array<Record<string, unknown>>;
  orderline?: Array<Record<string, unknown>>;
}

/** Fake Trino serving pool that routes each gold-mart query to the configured rows. */
function fakePool(t: FakeTables): SilverPool {
  return {
    async query<T = Record<string, unknown>>(sql: string): Promise<T[]> {
      if (sql.includes('gold_revenue_ledger')) return (t.revenue ?? []) as T[];
      if (sql.includes('gold_executive_metrics')) return (t.exec ?? []) as T[];
      if (sql.includes("churn_risk = 'high'")) return (t.churn ?? []) as T[];
      if (sql.includes('monetary_score = 5')) return (t.vip ?? []) as T[];
      if (sql.includes('gold_cac')) return (t.cac ?? []) as T[];
      if (sql.includes('silver_marketing_spend')) return (t.spend ?? []) as T[];
      if (sql.includes('silver_order_line')) return (t.orderline ?? []) as T[];
      if (sql.includes('silver_touchpoint')) return (t.funnel ?? []) as T[]; // computeStorefrontFunnel
      return [] as T[];
    },
  };
}

describe('computeInsights — deterministic Insight + Opportunity Engine', () => {
  it('detects a revenue drop with driver, RTO leakage, and churn opportunity; ranks by severity then $', async () => {
    const pool = fakePool({
      // Per (currency, event_type); sums to cur 82000 / prior 100000 (−18%). rto_reversal carries the
      // largest |delta| (−18000), so it is the top driver — same assertions, folded single read.
      revenue: [
        { currency_code: 'INR', event_type: 'order_paid', cur_minor: '100000', prior_minor: '100000' },
        { currency_code: 'INR', event_type: 'rto_reversal', cur_minor: '-18000', prior_minor: '0' },
      ],
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
      revenue: [{ currency_code: 'INR', event_type: 'order_paid', cur_minor: '5000', prior_minor: '0' }],
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

  it('computes blended ROAS from ad spend vs realized revenue (and fires only with spend)', async () => {
    // realized cur 150000 (from revenue row), spend 100000 → ROAS 1.50x → thin margins (medium, risk).
    const withSpend = await computeInsights(BRAND, {
      srPool: fakePool({
        revenue: [{ currency_code: 'INR', event_type: 'order_paid', cur_minor: '150000', prior_minor: '120000' }],
        spend: [{ currency_code: 'INR', spend_minor: '100000' }],
      }),
    });
    const roas = withSpend.insights.find((i) => i.detector === 'blended_roas')!;
    expect(roas.evidence.roas_x).toBe('1.50');
    expect(roas.impactMinor).toBe('100000'); // spend at stake
    expect(roas.severity).toBe('medium'); // 1 <= ROAS < 2
    expect(roas.kind).toBe('risk');

    // No spend → no ROAS insight (the ad-connector signal is absent).
    const noSpend = await computeInsights(BRAND, {
      srPool: fakePool({ revenue: [{ currency_code: 'INR', event_type: 'order_paid', cur_minor: '200000', prior_minor: '150000' }] }),
    });
    expect(noSpend.insights.find((i) => i.detector === 'blended_roas')).toBeUndefined();
  });

  it('surfaces the leakiest funnel step as an opportunity (reuses the conversion-funnel emitter)', async () => {
    // sessions 1000 → product 600 (60%) → cart 200 (33.33%) → checkout 120 (60%) → purchase 80 (66.67%).
    // Lowest step-conversion = cart_added (33.33%) → that's the leak; 400 dropped product-view→cart.
    const res = await computeInsights(BRAND, {
      srPool: fakePool({
        funnel: [{ sessions: 1000, product_viewed: 600, cart_added: 200, checkout_started: 120, purchased: 80 }],
      }),
    });
    const f = res.insights.find((i) => i.detector === 'funnel_dropoff')!;
    expect(f.kind).toBe('opportunity');
    expect(f.severity).toBe('medium'); // 20 <= 33.33 < 50
    expect(f.evidence.step_pct).toBe('33.33');
    expect(f.evidence.lost_sessions).toBe('400');
    expect(f.evidence.overall_conversion_pct).toBe('8.00'); // 80/1000
  });

  it('surfaces the top product + revenue concentration from order line-items', async () => {
    // Hero 600000 of total 1000000 = 60% → high-concentration opportunity across 3 products.
    const res = await computeInsights(BRAND, {
      srPool: fakePool({
        orderline: [
          { currency_code: 'INR', title: 'Hero Bodysuit', prod_minor: '600000' },
          { currency_code: 'INR', title: 'Mesh Tank', prod_minor: '300000' },
          { currency_code: 'INR', title: 'Gloss Set', prod_minor: '100000' },
        ],
      }),
    });
    const p = res.insights.find((i) => i.detector === 'product_concentration')!;
    expect(p.kind).toBe('opportunity');
    expect(p.severity).toBe('high'); // 60% >= 40
    expect(p.evidence.top_product).toBe('Hero Bodysuit');
    expect(p.evidence.top_share_pct).toBe('60.00');
    expect(p.evidence.distinct_products).toBe(3);
    expect(p.impactMinor).toBe('600000');
  });

  it('funnel: ignores trailing un-instrumented stages (0% checkout) and flags the real observed leak', async () => {
    // 660 → 541 product (82%) → 34 cart (6.28%) → 0 checkout → 0 purchase. checkout/purchase are
    // uninstrumented (storefront pixel emits no checkout events) → the leak is product→cart, NOT "0% checkout".
    const res = await computeInsights(BRAND, {
      srPool: fakePool({
        funnel: [{ sessions: 660, product_viewed: 541, cart_added: 34, checkout_started: 0, purchased: 0 }],
      }),
    });
    const f = res.insights.find((i) => i.detector === 'funnel_dropoff')!;
    expect(f.evidence.step_pct).toBe('6.28'); // 34/541, not 0% checkout
    expect(f.title).toContain('cart adds');
    expect(f.title).not.toContain('checkout');
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

  // ── evidence values must NEVER be null (BFF contract drift fix) ──────────────
  // The recommendation evidence contract is record(string, string|number|boolean) with NO null.
  // A persisted null (e.g. top_driver_event on a non-primary currency, or a null funnel step_pct)
  // makes the web↔core parse reject the whole response. Detectors must OMIT the key, not emit null.
  it('emits NO null evidence values across a rich multi-detector fixture', async () => {
    const res = await computeInsights(BRAND, {
      srPool: fakePool({
        // Two currencies → USD is a NON-primary currency (INR has the larger current window),
        // which is exactly where top_driver_event was previously emitted as null.
        revenue: [
          { currency_code: 'INR', event_type: 'order_paid', cur_minor: '100000', prior_minor: '80000' },
          { currency_code: 'INR', event_type: 'rto_reversal', cur_minor: '-9000', prior_minor: '0' },
          { currency_code: 'USD', event_type: 'order_paid', cur_minor: '2000', prior_minor: '3000' },
        ],
        exec: [{ currency_code: 'INR', realized_value_minor: '1000000', total_orders: '100', terminal_orders: '90', rto_orders: '18' }],
        churn: [{ currency_code: 'INR', high_risk_customers: '12', ltv_at_risk_minor: '870000' }],
        vip: [{ currency_code: 'INR', vip_customers: '5', vip_ltv_minor: '500000' }],
        cac: [
          { currency_code: 'INR', acquisition_month: '2026-06', spend_minor: '60000', new_customers: '40' },
          { currency_code: 'INR', acquisition_month: '2026-05', spend_minor: '40000', new_customers: '30' },
        ],
        spend: [{ currency_code: 'INR', spend_minor: '50000' }],
        orderline: [
          { currency_code: 'INR', title: 'Hero SKU', prod_minor: '400000' },
          { currency_code: 'INR', title: 'Other', prod_minor: '100000' },
        ],
        funnel: [{ sessions: 660, product_viewed: 541, cart_added: 34, checkout_started: 0, purchased: 0 }],
      }),
    });
    expect(res.insights.length).toBeGreaterThan(0);
    for (const insight of res.insights) {
      for (const [key, value] of Object.entries(insight.evidence)) {
        expect(value, `${insight.detector}.evidence.${key} must not be null`).not.toBeNull();
        expect(['string', 'number', 'boolean']).toContain(typeof value);
      }
    }
  });

  it('OMITS top_driver_event on a non-primary currency (never persists it as null)', async () => {
    const res = await computeInsights(BRAND, {
      srPool: fakePool({
        revenue: [
          { currency_code: 'INR', event_type: 'order_paid', cur_minor: '100000', prior_minor: '80000' },
          { currency_code: 'USD', event_type: 'order_paid', cur_minor: '2000', prior_minor: '3000' },
        ],
      }),
    });
    const inr = res.insights.find((i) => i.id === 'revenue_trend:INR')!;
    const usd = res.insights.find((i) => i.id === 'revenue_trend:USD')!;
    // primary (INR) carries the driver …
    expect(inr.evidence.top_driver_event).toBe('order_paid');
    // … non-primary (USD) OMITS the key entirely rather than storing null.
    expect('top_driver_event' in usd.evidence).toBe(false);
  });
});
