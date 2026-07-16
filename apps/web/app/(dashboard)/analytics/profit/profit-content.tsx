'use client';

/**
 * ProfitContent — the "True Profit" surface (Analytics › Profit).
 *
 * Platform dashboards report REVENUE and call it success. This page turns that top-line revenue
 * into real profit via a contribution-margin waterfall, so a brand can see what's actually left
 * after the products, the fulfilment, and the marketing are paid for:
 *
 *   Net revenue → −COGS → = CM1 (gross margin) → −Variable cost → −Marketing → = CM2 (contribution)
 *
 * It reads ONLY the BFF/metric-engine hook (never the serving tier / the ledger directly, never an inlined
 * client-side SUM):
 *   - useContributionMargin → CM1 / CM2 + a cost-confidence grade (Wave C).
 *
 * Money: every figure is a bigint minor-unit STRING paired with currency_code → formatMoneyDisplay
 * (never /100, never a float, never blended across currencies). The ONLY numeric coercion is
 * Number(BigInt(x)) to size the proportional bars — never to display a money value.
 *
 * Honest states: skeleton KpiTiles (isLoading), ErrorCard (isError), EmptyState (no_data), and —
 * critically — when cost_confidence is 'Insufficient' we say so loudly: CM2 is understated until
 * costs are entered. We never present an uncertain profit as trusted.
 */

import Link from 'next/link';
import { TrendingUp, Wallet, Receipt, Megaphone } from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { Card, CardContent } from '@/components/ui/card';
import { KpiTile } from '@/components/analytics/kpi-tile';
import { MetricTitle } from '@/components/ui/metric-title';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import { Button } from '@/components/ui/button';
import { useContributionMargin } from '@/lib/hooks/use-metrics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { ContributionMarginResponse } from '@/lib/api/types';

type MarginBlock = Extract<ContributionMarginResponse, { state: 'has_data' }>['margin'];
type CostConfidence = MarginBlock['cost_confidence'];

/** One step in the revenue → profit waterfall. */
interface WaterfallRow {
  key: string;
  label: string;
  /** ONE plain-language sentence for the row's "?" tooltip. */
  help: string;
  /** Signed minor-unit STRING as it should read (subtractions carry a leading '−'). */
  display: string;
  /** Non-negative minor-unit STRING used ONLY to size the proportional bar. */
  magnitudeMinor: string;
  /** A subtotal (= CM1 / = CM2) is emphasised and bar-tinted differently from a deduction. */
  kind: 'base' | 'deduction' | 'subtotal';
}

/** Cost-confidence badge palette (status is text, never colour alone — the word carries it). */
const CONFIDENCE_BADGE: Record<CostConfidence, string> = {
  Trusted: 'border-status-green-200 bg-status-green-50 text-status-green-700',
  Estimated: 'border-status-amber-200 bg-status-amber-50 text-status-amber-700',
  Insufficient: 'border-status-red-200 bg-status-red-50 text-status-red-700',
};

const CONFIDENCE_HELP: Record<CostConfidence, string> = {
  Trusted: 'Your cost inputs are complete — this profit is grounded in real costs, not estimates.',
  Estimated: 'Some costs are estimated from partial inputs — profit is directional, not exact.',
  Insufficient:
    'Costs are missing, so the contribution margin below is understated and cannot be trusted yet.',
};

/**
 * Turn the margin block into the ordered waterfall rows. Deductions are shown with a leading '−'
 * (formatMoneyDisplay of the positive amount) so the sign is explicit; the "variable cost" step is
 * only the fulfilment/packaging ABOVE COGS (variable_cost − cogs), because COGS is already its own
 * step — otherwise we'd double-count it. All arithmetic is bigint (no float, no /100).
 */
function buildWaterfall(m: MarginBlock): WaterfallRow[] {
  const fulfilmentMinor = (BigInt(m.variable_cost_minor) - BigInt(m.cogs_minor)).toString();
  return [
    {
      key: 'net_revenue',
      label: 'Net revenue',
      help: 'Revenue after refunds and cancellations — the real top line, before any costs.',
      display: formatMoneyDisplay(m.net_revenue_minor, m.currency_code as CurrencyCode),
      magnitudeMinor: m.net_revenue_minor,
      kind: 'base',
    },
    {
      key: 'cogs',
      label: '− Cost of goods (COGS)',
      help: 'What the products themselves cost you — the wholesale/manufacturing cost of what sold.',
      display: `− ${formatMoneyDisplay(m.cogs_minor, m.currency_code as CurrencyCode)}`,
      magnitudeMinor: m.cogs_minor,
      kind: 'deduction',
    },
    {
      key: 'cm1',
      label: '= Gross margin (CM1)',
      help: 'Net revenue minus cost of goods — what is left before fulfilment and marketing.',
      display: formatMoneyDisplay(m.cm1_minor, m.currency_code as CurrencyCode),
      magnitudeMinor: m.cm1_minor,
      kind: 'subtotal',
    },
    {
      key: 'variable_cost',
      label: '− Fulfilment & packaging',
      help: 'Variable cost beyond the product itself — shipping and packaging to get the order out.',
      display: `− ${formatMoneyDisplay(fulfilmentMinor, m.currency_code as CurrencyCode)}`,
      magnitudeMinor: fulfilmentMinor,
      kind: 'deduction',
    },
    {
      key: 'marketing',
      label: '− Marketing',
      help: 'Advertising spend allocated to these orders — what it cost to win the revenue.',
      display: `− ${formatMoneyDisplay(m.marketing_minor, m.currency_code as CurrencyCode)}`,
      magnitudeMinor: m.marketing_minor,
      kind: 'deduction',
    },
    {
      key: 'cm2',
      label: '= Contribution margin (CM2)',
      help: "What's left after product costs, fulfilment, and marketing — the profit that funds the business.",
      display: formatMoneyDisplay(m.cm2_minor, m.currency_code as CurrencyCode),
      magnitudeMinor: m.cm2_minor,
      kind: 'subtotal',
    },
  ];
}

/**
 * Bar width as a percentage of net revenue. Number(BigInt(x)) is used ONLY here (for pixel sizing) —
 * never for a displayed money value. Precision loss at that scale is invisible in a progress bar.
 */
function barPct(magnitudeMinor: string, netRevenueMinor: string): number {
  const net = Number(BigInt(netRevenueMinor));
  if (net <= 0) return 0;
  const mag = Math.abs(Number(BigInt(magnitudeMinor)));
  return Math.max(0, Math.min(100, (mag / net) * 100));
}

export function ProfitContent() {
  const marginQ = useContributionMargin();
  const data = marginQ.data;

  return (
    <div className="space-y-6">
      {/* ── Header ── */}
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">True profit</h1>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Platforms report revenue. This turns it into real profit — what is actually left after the
          products, the fulfilment, and the marketing are paid for.
        </p>
      </div>

      {/* ── Error takes over the whole surface (we can't honestly render partial profit) ── */}
      {marginQ.isError ? (
        <ErrorCard error={marginQ.error} retry={marginQ.refetch} />
      ) : marginQ.isLoading ? (
        <>
          {/* Loading → skeleton KpiTiles */}
          <section
            aria-label="Loading profit summary"
            className="grid grid-cols-1 gap-4 sm:grid-cols-3"
          >
            <KpiTile label="Gross margin (CM1)" value={null} isLoading />
            <KpiTile label="Contribution margin (CM2)" value={null} isLoading />
            <KpiTile label="Net revenue" value={null} isLoading />
          </section>
        </>
      ) : !data || data.state === 'no_data' ? (
        /* no_data → honest empty, pointing at the cost inputs that unlock this */
        <Card>
          <CardContent className="p-0">
            <EmptyState
              icon={<Wallet />}
              title="No profit data yet"
              description="Add your cost inputs (COGS, shipping, fees) so Brain can turn revenue into true profit. Until real costs exist, we won't fake a margin."
              action={
                <Link href="/analytics/margin">
                  <Button size="sm">Add cost inputs</Button>
                </Link>
              }
              hint={data ? `As of ${data.as_of}` : undefined}
            />
          </CardContent>
        </Card>
      ) : (
        <ProfitBody margin={data.margin} asOf={data.as_of} />
      )}
    </div>
  );
}

/** The loaded surface — headline KpiTiles, the confidence badge, and the waterfall. */
function ProfitBody({ margin, asOf }: { margin: MarginBlock; asOf: string }) {
  const ccy = margin.currency_code as CurrencyCode;
  const confidence = margin.cost_confidence;
  const estimated = confidence !== 'Trusted';
  const insufficient = confidence === 'Insufficient';
  const rows = buildWaterfall(margin);

  return (
    <>
      {/* ── Headline KpiTiles ── */}
      <section
        aria-label="Profit summary"
        className="grid grid-cols-1 gap-4 sm:grid-cols-3"
        data-testid="profit-kpis"
      >
        <KpiTile
          label="Gross margin (CM1)"
          help="Net revenue minus cost of goods."
          value={formatMoneyDisplay(margin.cm1_minor, ccy)}
          estimated={estimated}
        />
        <KpiTile
          label="Contribution margin (CM2)"
          help="What's left after product costs, fulfilment, and marketing — the profit that funds the business."
          value={formatMoneyDisplay(margin.cm2_minor, ccy)}
          estimated={estimated}
          sublabel={insufficient ? 'Understated until costs are added' : undefined}
        />
        <KpiTile
          label="Net revenue"
          help="Revenue after refunds and cancellations — the real top line, before any costs."
          value={formatMoneyDisplay(margin.net_revenue_minor, ccy)}
        />
      </section>

      {/* ── Insufficient-cost warning: never present an uncertain profit as trusted ── */}
      {insufficient && (
        <div
          className="rounded-lg border border-status-red-200 bg-status-red-50 p-4 text-sm text-status-red-700"
          role="alert"
          data-testid="profit-insufficient-warning"
        >
          <p className="font-medium">Contribution margin is understated.</p>
          <p className="mt-1 text-status-red-700/90">
            Your cost inputs are incomplete, so fulfilment and product costs are missing from the
            maths. The CM2 above is a floor, not the truth — add your costs to see real profit.{' '}
            <Link href="/analytics/margin" className="font-medium underline underline-offset-4">
              Add cost inputs
            </Link>
            .
          </p>
        </div>
      )}

      {/* ── Waterfall: revenue → profit, step by step ── */}
      <SectionCard
        title={
          <MetricTitle
            label="Revenue to profit"
            help="Profit accuracy depends on how complete your cost inputs are."
            estimated={estimated}
          />
        }
        description="Each step takes a real cost out of the top-line revenue until only the contribution margin remains."
        actions={
          <span
            className={`inline-flex items-center rounded-full border px-2.5 py-0.5 text-xs font-medium ${CONFIDENCE_BADGE[confidence]}`}
            role="status"
            aria-label={`Cost confidence: ${confidence}. ${CONFIDENCE_HELP[confidence]}`}
            title={CONFIDENCE_HELP[confidence]}
            data-testid="cost-confidence-badge"
          >
            {confidence}
          </span>
        }
        meta={<span className="text-xs text-muted-foreground">As of {asOf}</span>}
      >
        <ol className="space-y-3" data-testid="profit-waterfall">
          {rows.map((row) => (
            <li key={row.key} className="space-y-1.5">
              <div className="flex items-baseline justify-between gap-4">
                <span
                  className={
                    row.kind === 'subtotal'
                      ? 'flex items-center gap-1.5 text-sm font-semibold text-foreground'
                      : 'flex items-center gap-1.5 text-sm text-muted-foreground'
                  }
                >
                  <WaterfallIcon kind={row.kind} rowKey={row.key} />
                  <MetricTitle label={row.label} help={row.help} />
                </span>
                <span
                  className={
                    row.kind === 'subtotal'
                      ? 'text-sm font-semibold tabular-nums text-foreground'
                      : 'text-sm tabular-nums text-muted-foreground'
                  }
                >
                  {row.display}
                </span>
              </div>
              {/* Subtle proportional bar — width = |amount| ÷ net revenue. */}
              <div
                className="h-1.5 w-full overflow-hidden rounded-full bg-muted"
                aria-hidden="true"
              >
                <div
                  className={
                    row.kind === 'deduction'
                      ? 'h-full rounded-full bg-status-amber-300'
                      : row.kind === 'subtotal'
                        ? 'h-full rounded-full bg-primary'
                        : 'h-full rounded-full bg-foreground/40'
                  }
                  style={{ width: `${barPct(row.magnitudeMinor, margin.net_revenue_minor)}%` }}
                />
              </div>
            </li>
          ))}
        </ol>
      </SectionCard>
    </>
  );
}

/** Small leading icon per waterfall step — decorative (the label carries the meaning). */
function WaterfallIcon({ kind, rowKey }: { kind: WaterfallRow['kind']; rowKey: string }) {
  const cls = 'size-3.5 shrink-0';
  if (kind === 'subtotal') return <TrendingUp className={cls} aria-hidden="true" />;
  if (rowKey === 'marketing') return <Megaphone className={cls} aria-hidden="true" />;
  if (kind === 'base') return <Wallet className={cls} aria-hidden="true" />;
  return <Receipt className={cls} aria-hidden="true" />;
}
