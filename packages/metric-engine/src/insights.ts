/**
 * @brain/metric-engine — computeInsights (Insight + Opportunity Engine).
 *
 * The deterministic-first engine behind the AI Copilot's daily briefing. It reads ONLY the existing
 * Gold marts through withSilverBrand (I-ST01 — the engine is the sole Gold reader; the UI never
 * queries StarRocks) and derives a ranked set of INSIGHTS (what changed), RISKS (money leaking) and
 * OPPORTUNITIES (money recoverable). Every figure is computed from exact integer operands (BIGINT
 * minor units + currency_code, I-S07); ratios are exact decimal strings, never floats; and a metric
 * with no supporting rows yields NO insight rather than a fabricated zero (no-empty-charts rule).
 *
 * Brain rule respected: numbers come from the marts, NEVER from a model. The LLM layer (apps/core
 * briefing) only narrates these already-computed numbers — it cannot alter them.
 *
 * Sources (all real marts):
 *   - revenue swing + driver   ← gold_revenue_ledger (occurred_at, amount_minor, event_type)
 *   - RTO leakage (risk)       ← gold_executive_metrics (rto_orders, terminal_orders, realized, orders)
 *   - churn LTV-at-risk (opp)  ← gold_customer_scores (churn_risk='high', lifetime_value_minor)
 *   - VIP concentration (opp)  ← gold_customer_scores (monetary_score=5)
 *   - CAC trend                ← gold_cac (acquisition_month, spend, new_customers)
 *
 * @see executive-metrics.ts / cac.ts / customer-score.ts (sibling Gold readers, same seam)
 */

import type { SilverPool } from './silver-deps.js';
import { withSilverBrand, BRAND_PREDICATE } from './silver-deps.js';
import { computeStorefrontFunnel } from './storefront-funnel.js';

export type InsightKind = 'risk' | 'opportunity' | 'trend';
export type InsightSeverity = 'high' | 'medium' | 'low' | 'info';
/** Deterministic data-sufficiency grade for THIS insight (not the brand-wide dq trust grade). */
export type InsightConfidence = 'high' | 'medium' | 'low';

export interface Insight {
  /** Stable id per (detector, currency) so the UI can dedup/refresh. */
  id: string;
  detector: string;
  kind: InsightKind;
  severity: InsightSeverity;
  title: string;
  /** One-line, mart-grounded explanation of WHY (the "why did it happen"). */
  why: string;
  /** The concrete next step (what the operator should do). */
  recommendedAction: string;
  currencyCode: string | null;
  /** Headline money impact (BIGINT minor-unit string) — swing/leak/recoverable; null when not money. */
  impactMinor: string | null;
  /** Direction of the change, when the insight is a delta. */
  direction: 'up' | 'down' | 'flat' | null;
  /** Percent change as an exact decimal string (e.g. "-18.42"); null when not a delta. */
  deltaPct: string | null;
  /** Supporting figures (all exact strings / ints) for the drill + tooltip. */
  evidence: Record<string, string | number | null>;
  confidence: InsightConfidence;
}

export interface InsightsResult {
  hasData: boolean;
  /** The currency the briefing leads with (the one with the most realized revenue). */
  primaryCurrency: string | null;
  /** Inclusive window the deltas were computed over (ISO dates). */
  window: { current: { from: string; to: string }; prior: { from: string; to: string } };
  insights: Insight[];
}

// ── exact-integer helpers (no float) ─────────────────────────────────────────
function bi(v: string | number | null | undefined): bigint {
  return BigInt(String(v ?? '0').split('.')[0] || '0');
}
function abs(v: bigint): bigint {
  return v < 0n ? -v : v;
}
/** numerator/denominator → fixed-precision decimal string from exact integer operands. */
function ratioStr(numerator: bigint, denominator: bigint, fractionalDigits = 2): string {
  if (denominator === 0n) return '0';
  const scale = 10n ** BigInt(fractionalDigits);
  const scaled = (numerator * scale) / denominator;
  const intPart = scaled / scale;
  const fracPart = abs(scaled % scale);
  return `${intPart.toString()}.${fracPart.toString().padStart(fractionalDigits, '0')}`;
}
/**
 * Percent change ((cur-prior)/prior)*100 as exact string; null when the prior base is non-positive
 * (a % vs a zero/negative base is meaningless — report the absolute swing + direction instead, no ∞
 * and no sign-flip artefacts from dividing by a negative net-realized base).
 */
function pctChange(cur: bigint, prior: bigint): string | null {
  if (prior <= 0n) return null;
  return ratioStr((cur - prior) * 100n, prior);
}
function severityFromAbsPct(pctAbs: number): InsightSeverity {
  if (pctAbs >= 15) return 'high';
  if (pctAbs >= 5) return 'medium';
  return 'low';
}
function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * computeInsights — the ranked insight/opportunity/risk feed for one brand.
 *
 * @param brandId - Brand UUID (from session — D-1).
 * @param deps    - The StarRocks Gold pool (gold_revenue_ledger/executive_metrics/customer_scores/cac).
 * @returns       Ranked insights (highest money-impact + severity first); hasData=false when the
 *                brand has no realized revenue rows at all (honest empty).
 */
export async function computeInsights(
  brandId: string,
  deps: { srPool: SilverPool },
): Promise<InsightsResult> {
  const now = new Date();
  const curFrom = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
  const priorFrom = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
  const window = {
    current: { from: isoDate(curFrom), to: isoDate(now) },
    prior: { from: isoDate(priorFrom), to: isoDate(curFrom) },
  };

  // Storefront conversion funnel (current 30d) — computed via the canonical funnel emitter (own seam);
  // reused below for the funnel-drop-off insight. Best-effort: a failure degrades to "no funnel insight".
  const funnel = await computeStorefrontFunnel(brandId, deps, { from: curFrom, to: now }).catch(() => ({
    hasData: false,
    stages: [] as { key: string; sessions: bigint; conversionPct: string | null; stepPct: string | null }[],
  }));

  return withSilverBrand(deps.srPool, brandId, async (scope) => {
    const insights: Insight[] = [];
    // Current-window net realized per currency (reused by the ROAS detector below).
    const revCurByCcy = new Map<string, bigint>();

    // ── 1. Revenue swing (current 30d vs prior 30d) + biggest driver event_type ──
    const revRows = await scope.runScoped<{
      currency_code: string;
      cur_minor: string | number;
      prior_minor: string | number;
    }>(
      `SELECT currency_code,
              SUM(CASE WHEN occurred_at >= CAST('${window.current.from} 00:00:00' AS timestamp(6) with time zone) THEN amount_minor ELSE 0 END) AS cur_minor,
              SUM(CASE WHEN occurred_at >= CAST('${window.prior.from} 00:00:00' AS timestamp(6) with time zone)
                        AND occurred_at <  CAST('${window.current.from} 00:00:00' AS timestamp(6) with time zone) THEN amount_minor ELSE 0 END) AS prior_minor
         FROM brain_serving.mv_gold_revenue_ledger
        WHERE occurred_at >= CAST('${window.prior.from} 00:00:00' AS timestamp(6) with time zone)
          AND ${BRAND_PREDICATE}
        GROUP BY currency_code`,
      [],
    );

    // Pick the primary currency = largest current-window realized revenue.
    let primaryCurrency: string | null = null;
    let primaryCur = -1n;
    for (const r of revRows) {
      const cur = bi(r.cur_minor);
      if (cur > primaryCur) {
        primaryCur = cur;
        primaryCurrency = r.currency_code;
      }
    }

    // Driver breakdown by event_type for the primary currency (which event moved revenue most).
    let topDriver: { eventType: string; delta: bigint } | null = null;
    if (primaryCurrency) {
      const drv = await scope.runScoped<{
        event_type: string;
        cur_minor: string | number;
        prior_minor: string | number;
      }>(
        `SELECT event_type,
                SUM(CASE WHEN occurred_at >= CAST('${window.current.from} 00:00:00' AS timestamp(6) with time zone) THEN amount_minor ELSE 0 END) AS cur_minor,
                SUM(CASE WHEN occurred_at >= CAST('${window.prior.from} 00:00:00' AS timestamp(6) with time zone)
                          AND occurred_at <  CAST('${window.current.from} 00:00:00' AS timestamp(6) with time zone) THEN amount_minor ELSE 0 END) AS prior_minor
           FROM brain_serving.mv_gold_revenue_ledger
          WHERE occurred_at >= CAST('${window.prior.from} 00:00:00' AS timestamp(6) with time zone)
            AND currency_code = ?
            AND ${BRAND_PREDICATE}
          GROUP BY event_type`,
        [primaryCurrency],
      );
      for (const d of drv) {
        const delta = bi(d.cur_minor) - bi(d.prior_minor);
        if (!topDriver || abs(delta) > abs(topDriver.delta)) {
          topDriver = { eventType: d.event_type, delta };
        }
      }
    }

    for (const r of revRows) {
      const cur = bi(r.cur_minor);
      const prior = bi(r.prior_minor);
      revCurByCcy.set(r.currency_code, cur);
      const swing = cur - prior;
      const pct = pctChange(cur, prior);
      const pctNum = pct === null ? 0 : Math.abs(Number(pct));
      const direction: Insight['direction'] = swing > 0n ? 'up' : swing < 0n ? 'down' : 'flat';
      const isPrimary = r.currency_code === primaryCurrency;
      const driverNote =
        isPrimary && topDriver
          ? ` Largest driver: '${topDriver.eventType}' moved ${topDriver.delta < 0n ? '-' : '+'}${abs(topDriver.delta).toString()} minor.`
          : '';
      // When the prior base is non-positive we can't quote a %, so lead with the direction only;
      // severity falls back to a medium band (a real swing the operator should look at).
      const pctLabel = pct !== null ? ` ${pct}%` : '';
      insights.push({
        id: `revenue_trend:${r.currency_code}`,
        detector: 'revenue_trend',
        kind: swing < 0n ? 'risk' : 'trend',
        severity:
          swing < 0n ? (pct !== null ? severityFromAbsPct(pctNum) : 'medium') : pctNum >= 15 ? 'medium' : 'info',
        title:
          swing < 0n
            ? `Revenue down${pctLabel} (last 30d vs prior 30d)`
            : `Revenue up${pctLabel} (last 30d vs prior 30d)`,
        why:
          `Realized revenue moved from ${prior.toString()} to ${cur.toString()} minor (${r.currency_code}) ` +
          `between the prior and current 30-day windows.${driverNote}`,
        recommendedAction:
          swing < 0n
            ? 'Open the revenue drill and the attribution view to find which channel/SKU drove the drop; check RTO and refund leakage below.'
            : 'Confirm the gain is realized (not provisional) and double down on the channels driving it.',
        currencyCode: r.currency_code,
        impactMinor: abs(swing).toString(),
        direction,
        deltaPct: pct,
        evidence: {
          current_minor: cur.toString(),
          prior_minor: prior.toString(),
          top_driver_event: isPrimary && topDriver ? topDriver.eventType : null,
        },
        confidence: prior <= 0n ? 'low' : 'high',
      });
    }

    // ── 2. RTO leakage (risk) ← gold_executive_metrics ──
    const execRows = await scope.runScoped<{
      currency_code: string;
      realized_value_minor: string | number;
      total_orders: string | number;
      terminal_orders: string | number;
      rto_orders: string | number;
    }>(
      `SELECT currency_code,
              COALESCE(SUM(realized_value_minor), 0) AS realized_value_minor,
              COALESCE(SUM(total_orders), 0)         AS total_orders,
              COALESCE(SUM(terminal_orders), 0)      AS terminal_orders,
              COALESCE(SUM(rto_orders), 0)           AS rto_orders
         FROM brain_serving.mv_gold_executive_metrics
        WHERE ${BRAND_PREDICATE}
        GROUP BY currency_code`,
      [],
    );
    for (const r of execRows) {
      const realized = bi(r.realized_value_minor);
      const orders = bi(r.total_orders);
      const terminal = bi(r.terminal_orders);
      const rto = bi(r.rto_orders);
      if (terminal === 0n || rto === 0n) continue;
      const rtoRatePct = ratioStr(rto * 100n, terminal);
      // AOV only makes sense on a positive realized base; when net realized is ≤0 (severe returns),
      // the RTO RATE is still the headline signal but we don't quote a (nonsensical negative) ₹-leak.
      const aovMinor = orders > 0n && realized > 0n ? realized / orders : 0n;
      const leakedMinor = aovMinor > 0n ? aovMinor * rto : null; // RTO orders × AOV ≈ GMV lost
      const rateNum = Number(rtoRatePct);
      insights.push({
        id: `rto_leakage:${r.currency_code}`,
        detector: 'rto_leakage',
        kind: 'risk',
        severity: rateNum >= 10 ? 'high' : rateNum >= 5 ? 'medium' : 'low',
        title: `COD/RTO leakage at ${rtoRatePct}% of terminal orders`,
        why:
          leakedMinor !== null
            ? `${rto.toString()} of ${terminal.toString()} terminal orders were returned (RTO). At an AOV of ` +
              `${aovMinor.toString()} minor (${r.currency_code}), that is ~${leakedMinor.toString()} minor of GMV lost.`
            : `${rto.toString()} of ${terminal.toString()} terminal orders were returned (RTO) — a ${rtoRatePct}% ` +
              `return rate. Net realized revenue is already ≤0 here, so returns are eroding the whole P&L.`,
        recommendedAction:
          'Gate high-RTO-risk COD checkouts (address confidence / partial prepaid) and review the worst pincodes/couriers.',
        currencyCode: r.currency_code,
        impactMinor: leakedMinor !== null ? leakedMinor.toString() : null,
        direction: null,
        deltaPct: null,
        evidence: {
          rto_orders: rto.toString(),
          terminal_orders: terminal.toString(),
          rto_rate_pct: rtoRatePct,
          aov_minor: aovMinor.toString(),
        },
        confidence: orders > 0n ? 'high' : 'medium',
      });
    }

    // ── 3. Churn LTV-at-risk (opportunity) ← gold_customer_scores ──
    const churnRows = await scope.runScoped<{
      currency_code: string;
      high_risk_customers: string | number;
      ltv_at_risk_minor: string | number;
    }>(
      `SELECT currency_code,
              COUNT(*)                       AS high_risk_customers,
              COALESCE(SUM(lifetime_value_minor), 0) AS ltv_at_risk_minor
         FROM brain_serving.mv_gold_customer_scores
        WHERE churn_risk = 'high'
          AND ${BRAND_PREDICATE}
        GROUP BY currency_code`,
      [],
    );
    for (const r of churnRows) {
      const count = bi(r.high_risk_customers);
      const ltv = bi(r.ltv_at_risk_minor);
      if (count === 0n) continue;
      insights.push({
        id: `churn_recovery:${r.currency_code}`,
        detector: 'churn_recovery',
        kind: 'opportunity',
        severity: ltv > 0n ? 'high' : 'medium',
        title: `${count.toString()} high-value customers at churn risk`,
        why:
          `${count.toString()} customers are flagged high churn-risk (RFM recency/frequency decay), carrying ` +
          `${ltv.toString()} minor (${r.currency_code}) of realized lifetime value that is recoverable.`,
        recommendedAction:
          'Build a win-back segment from these customers and trigger a lifecycle campaign before they lapse.',
        currencyCode: r.currency_code,
        impactMinor: ltv.toString(),
        direction: null,
        deltaPct: null,
        evidence: { high_risk_customers: count.toString(), ltv_at_risk_minor: ltv.toString() },
        confidence: 'high',
      });
    }

    // ── 4. VIP concentration (opportunity) ← gold_customer_scores (monetary_score=5) ──
    const vipRows = await scope.runScoped<{
      currency_code: string;
      vip_customers: string | number;
      vip_ltv_minor: string | number;
    }>(
      `SELECT currency_code,
              COUNT(*)                               AS vip_customers,
              COALESCE(SUM(lifetime_value_minor), 0) AS vip_ltv_minor
         FROM brain_serving.mv_gold_customer_scores
        WHERE monetary_score = 5
          AND ${BRAND_PREDICATE}
        GROUP BY currency_code`,
      [],
    );
    for (const r of vipRows) {
      const count = bi(r.vip_customers);
      const ltv = bi(r.vip_ltv_minor);
      if (count === 0n) continue;
      insights.push({
        id: `vip_concentration:${r.currency_code}`,
        detector: 'vip_concentration',
        kind: 'opportunity',
        severity: 'medium',
        title: `${count.toString()} VIP customers drive ${ltv.toString()} minor of LTV`,
        why:
          `Your top monetary-tier (RFM monetary score 5) holds ${count.toString()} customers worth ` +
          `${ltv.toString()} minor (${r.currency_code}) in realized lifetime value.`,
        recommendedAction:
          'Launch a VIP retention / early-access program and a lookalike acquisition campaign off this cohort.',
        currencyCode: r.currency_code,
        impactMinor: ltv.toString(),
        direction: null,
        deltaPct: null,
        evidence: { vip_customers: count.toString(), vip_ltv_minor: ltv.toString() },
        confidence: 'high',
      });
    }

    // ── 5. CAC trend (latest acquisition_month vs prior) ← gold_cac ──
    const cacRows = await scope.runScoped<{
      currency_code: string;
      acquisition_month: string;
      spend_minor: string | number;
      new_customers: string | number;
    }>(
      `SELECT currency_code, acquisition_month,
              COALESCE(SUM(acquisition_spend_minor), 0) AS spend_minor,
              COALESCE(SUM(new_customers), 0)           AS new_customers
         FROM brain_serving.mv_gold_cac
        WHERE ${BRAND_PREDICATE}
        GROUP BY currency_code, acquisition_month
        ORDER BY acquisition_month DESC`,
      [],
    );
    // Group the two most-recent months per currency.
    const cacByCcy = new Map<string, Array<{ month: string; spend: bigint; cust: bigint }>>();
    for (const r of cacRows) {
      const arr = cacByCcy.get(r.currency_code) ?? [];
      if (arr.length < 2) arr.push({ month: r.acquisition_month, spend: bi(r.spend_minor), cust: bi(r.new_customers) });
      cacByCcy.set(r.currency_code, arr);
    }
    for (const [ccy, months] of cacByCcy) {
      if (months.length < 2) continue;
      const [latest, prev] = months as [{ month: string; spend: bigint; cust: bigint }, { month: string; spend: bigint; cust: bigint }];
      if (latest.cust === 0n || prev.cust === 0n) continue;
      const latestCac = latest.spend / latest.cust;
      const prevCac = prev.spend / prev.cust;
      // No ad spend in either month → CAC is 0/0-meaningless; don't emit a "CAC improving ?%" insight.
      if (latest.spend === 0n && prev.spend === 0n) continue;
      const pct = pctChange(latestCac, prevCac);
      const pctNum = pct === null ? 0 : Math.abs(Number(pct));
      const rising = latestCac > prevCac;
      const cacPctLabel = pct !== null ? ` ${pct}%` : '';
      insights.push({
        id: `cac_trend:${ccy}`,
        detector: 'cac_trend',
        kind: rising ? 'risk' : 'trend',
        severity: rising ? severityFromAbsPct(pctNum) : 'info',
        title: rising
          ? `CAC rising${cacPctLabel} MoM (${latest.month})`
          : `CAC improving${cacPctLabel} MoM (${latest.month})`,
        why:
          `Acquisition cost moved from ${prevCac.toString()} (${prev.month}) to ${latestCac.toString()} minor ` +
          `(${latest.month}) per new customer in ${ccy}.`,
        recommendedAction: rising
          ? 'Audit channel efficiency — pause the campaigns whose CAC exceeds contribution margin; shift budget to your best ROAS channel.'
          : 'Reinvest the efficiency gain into your best-performing channel while CAC is favorable.',
        currencyCode: ccy,
        impactMinor: null,
        direction: rising ? 'up' : 'down',
        deltaPct: pct,
        evidence: {
          latest_month: latest.month,
          latest_cac_minor: latestCac.toString(),
          prior_month: prev.month,
          prior_cac_minor: prevCac.toString(),
        },
        confidence: 'high',
      });
    }

    // ── 6. Blended ROAS (current 30d) ← ad spend (silver_marketing_spend) vs realized revenue ──
    // Blended (not attributed): realized revenue ÷ ad spend in the window. Fires only when there IS
    // ad spend (the ad-connector signal). ROAS<1 = losing money on ads (high); <2 = thin (medium).
    const spendRows = await scope.runScoped<{ currency_code: string; spend_minor: string | number }>(
      `SELECT currency_code, COALESCE(SUM(spend_minor), 0) AS spend_minor
         FROM brain_serving.mv_silver_marketing_spend
        WHERE stat_date >= DATE '${window.current.from}' AND stat_date <= DATE '${window.current.to}'
          AND ${BRAND_PREDICATE}
        GROUP BY currency_code`,
      [],
    );
    for (const r of spendRows) {
      const spend = bi(r.spend_minor);
      if (spend === 0n) continue; // no ad spend → no ROAS insight
      const realized = revCurByCcy.get(r.currency_code) ?? 0n;
      const roas = ratioStr(realized, spend); // realized ÷ spend to 2 dp (e.g. '2.45' = 2.45x)
      const roasNum = Number(roas);
      const losing = realized <= 0n || roasNum < 1;
      insights.push({
        id: `blended_roas:${r.currency_code}`,
        detector: 'blended_roas',
        kind: losing || roasNum < 2 ? 'risk' : 'trend',
        severity: realized <= 0n ? 'high' : roasNum < 1 ? 'high' : roasNum < 2 ? 'medium' : 'info',
        title:
          realized <= 0n
            ? `Ads not returning — ${spend.toString()} minor spent, realized revenue ≤0 (last 30d)`
            : `Blended ROAS ${roas}x (last 30d)`,
        why:
          `Spent ${spend.toString()} minor (${r.currency_code}) on ads in the last 30 days against ` +
          `${realized.toString()} minor of net realized revenue (blended, not attributed).`,
        recommendedAction:
          losing
            ? 'Pause the worst-ROAS campaigns now — spend is exceeding the revenue it returns; shift budget to your best channel and fix RTO/refund leakage eroding realized revenue.'
            : roasNum < 2
              ? 'Margins are thin at this ROAS — tighten targeting/creatives and re-check contribution margin before scaling spend.'
              : 'Healthy blended ROAS — scale the winning channels while efficiency holds.',
        currencyCode: r.currency_code,
        impactMinor: spend.toString(),
        direction: null,
        deltaPct: null,
        evidence: { spend_minor: spend.toString(), realized_minor: realized.toString(), roas_x: roas },
        confidence: 'high',
      });
    }

    // ── 7. Funnel drop-off (opportunity) ← storefront conversion funnel (silver_touchpoint) ──
    // The leakiest step (lowest step-conversion) is where the most shoppers are lost — the highest-
    // leverage CRO fix. Brand-level (no currency). Honest: only when the funnel has sessions.
    if (funnel.hasData && funnel.stages.length >= 2) {
      const HUMAN: Record<string, string> = {
        sessions: 'sessions',
        product_viewed: 'product views',
        cart_added: 'cart adds',
        checkout_started: 'checkout',
        purchased: 'purchase',
      };
      const top = funnel.stages[0];
      // Cap at the last stage that actually has sessions: a trailing all-zero stage (e.g. checkout
      // when the storefront pixel doesn't emit checkout events — a Shopify checkout-extensibility gap,
      // not a CRO leak) would otherwise be flagged as "0% reach …" and bury the real observed leak.
      let lastNonZero = 0;
      for (let k = 0; k < funnel.stages.length; k++) {
        if ((funnel.stages[k]?.sessions ?? 0n) > 0n) lastNonZero = k;
      }
      const purchased = funnel.stages[lastNonZero];
      let worst: { key: string; prevKey: string; stepNum: number; stepPct: string | null; lost: bigint } | null = null;
      for (let k = 1; k <= lastNonZero; k++) {
        const st = funnel.stages[k];
        const prev = funnel.stages[k - 1];
        if (!st || !prev || prev.sessions === 0n) continue;
        const stepNum = st.stepPct === null ? 100 : Number(st.stepPct);
        const lost = prev.sessions - st.sessions;
        if (lost <= 0n) continue;
        if (!worst || stepNum < worst.stepNum) {
          worst = { key: st.key, prevKey: prev.key, stepNum, stepPct: st.stepPct, lost };
        }
      }
      if (worst && top) {
        const toCheckout = worst.key === 'purchased' || worst.key === 'checkout_started';
        insights.push({
          id: 'funnel_dropoff',
          detector: 'funnel_dropoff',
          kind: 'opportunity',
          severity: worst.stepNum < 20 ? 'high' : worst.stepNum < 50 ? 'medium' : 'low',
          title: `Funnel leak: only ${worst.stepPct ?? '?'}% of ${HUMAN[worst.prevKey] ?? worst.prevKey} reach ${HUMAN[worst.key] ?? worst.key}`,
          why:
            `${top.sessions.toString()} sessions in the last 30 days; ${worst.lost.toString()} dropped between ` +
            `${HUMAN[worst.prevKey] ?? worst.prevKey} and ${HUMAN[worst.key] ?? worst.key}. Sessions reaching ` +
            `${HUMAN[purchased?.key ?? ''] ?? purchased?.key ?? 'the last tracked stage'}: ${purchased?.conversionPct ?? '?'}%` +
            `${lastNonZero < funnel.stages.length - 1 ? ' (checkout/purchase not yet tracked by the storefront pixel).' : '.'}`,
          recommendedAction: toCheckout
            ? 'Recover abandoned carts/checkouts (reminder + incentive) and cut checkout friction (address/payment).'
            : 'Improve the on-site experience at this stage (PDP merchandising, search, cart UX).',
          currencyCode: null,
          impactMinor: null,
          direction: null,
          deltaPct: null,
          evidence: {
            top_sessions: top.sessions.toString(),
            lost_sessions: worst.lost.toString(),
            step_pct: worst.stepPct,
            overall_conversion_pct: purchased?.conversionPct ?? null,
          },
          confidence: 'high',
        });
      }
    }

    // ── 8. Top product / revenue concentration (opportunity) ← silver_order_line ──
    // The hero SKU is a lever (scale via lookalikes/bundles); over-concentration in one SKU is also a
    // risk (supply / margin single-point-of-failure). One insight per currency, off real line-items.
    const prodRows = await scope.runScoped<{
      currency_code: string;
      title: string;
      prod_minor: string | number;
    }>(
      `SELECT currency_code, COALESCE(title, '(untitled)') AS title,
              COALESCE(SUM(line_total_minor), 0) AS prod_minor
         FROM brain_serving.mv_silver_order_line
        WHERE ${BRAND_PREDICATE} AND line_total_minor IS NOT NULL
        GROUP BY currency_code, title`,
      [],
    );
    const byCcyProducts = new Map<string, { total: bigint; top: bigint; topTitle: string; count: number }>();
    for (const r of prodRows) {
      const minor = bi(r.prod_minor);
      const agg = byCcyProducts.get(r.currency_code) ?? { total: 0n, top: 0n, topTitle: '', count: 0 };
      agg.total += minor;
      agg.count += 1;
      if (minor > agg.top) {
        agg.top = minor;
        agg.topTitle = r.title;
      }
      byCcyProducts.set(r.currency_code, agg);
    }
    for (const [ccy, p] of byCcyProducts) {
      if (p.total <= 0n || p.top <= 0n) continue;
      const sharePct = ratioStr(p.top * 100n, p.total);
      const shareNum = Number(sharePct);
      const concentrated = shareNum >= 25;
      insights.push({
        id: `product_concentration:${ccy}`,
        detector: 'product_concentration',
        kind: 'opportunity',
        severity: shareNum >= 40 ? 'high' : shareNum >= 25 ? 'medium' : 'low',
        title: `Top product '${p.topTitle}' drives ${sharePct}% of product revenue`,
        why:
          `Across ${p.count.toString()} products (${ccy}), '${p.topTitle}' is ${p.top.toString()} minor of ` +
          `${p.total.toString()} minor in line-item revenue (${sharePct}%).`,
        recommendedAction: concentrated
          ? 'High revenue concentration in one SKU — protect supply + margin, and broaden the catalog; bundle it to lift AOV and de-risk.'
          : 'Scale your top product with lookalike acquisition + bundles, and promote the next tier to widen the revenue mix.',
        currencyCode: ccy,
        impactMinor: p.top.toString(),
        direction: null,
        deltaPct: null,
        evidence: {
          top_product: p.topTitle,
          top_revenue_minor: p.top.toString(),
          top_share_pct: sharePct,
          distinct_products: p.count,
          total_line_revenue_minor: p.total.toString(),
        },
        confidence: 'high',
      });
    }

    if (insights.length === 0) {
      return { hasData: false, primaryCurrency: null, window, insights: [] };
    }

    // Rank: severity weight first, then money impact desc.
    const sevWeight: Record<InsightSeverity, number> = { high: 3, medium: 2, low: 1, info: 0 };
    insights.sort((a, b) => {
      const s = sevWeight[b.severity] - sevWeight[a.severity];
      if (s !== 0) return s;
      const ai = a.impactMinor ? abs(BigInt(a.impactMinor)) : 0n;
      const biV = b.impactMinor ? abs(BigInt(b.impactMinor)) : 0n;
      return ai < biV ? 1 : ai > biV ? -1 : 0;
    });

    return { hasData: true, primaryCurrency, window, insights };
  });
}
