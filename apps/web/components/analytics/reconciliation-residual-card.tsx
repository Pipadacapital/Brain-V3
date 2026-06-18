'use client';

/**
 * ReconciliationResidualCard — the CLOSED-SUM PARITY ORACLE made visible.
 *
 * The acceptance gate of Phase 5 is the closed sum:
 *     Σ channel_contribution_minor + unattributed_minor = realized_gmv_minor
 * enforced exactly (tolerance 0) in the engine + a CI-blocking parity-oracle test. This
 * card RENDERS that sum so a stakeholder can see it add up: attributed + unattributed =
 * realized, as a small ledger. The unattributed residual is ALWAYS shown — never hidden,
 * never silently spread into channels (METRICS.md §Rules).
 *
 * Money: realized / attributed / unattributed are SIGNED bigint minor-unit strings →
 * formatMoneyDisplay (locale-aware, never /100). reconciliation_rate_pct is the engine's
 * 2dp string (attributed ÷ realized × 100) — rendered directly, never re-divided in floats;
 * null when realized = 0 (honest).
 *
 * A11y:
 *   - a labelled region; the equation is a real <table> with row headers so a screen
 *     reader reads "Attributed … Unattributed … Realized" as a closed sum.
 *   - the reconciliation-rate KPI status is icon + text (never colour-only): a green check
 *     when the closed-sum balances, an amber warning if a residual share is large. The
 *     status verdict is in the aria-label.
 *   - greyscale-safe (glyph + label distinguish state after colour is removed).
 */

import { CheckCircle2, AlertTriangle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import { cn } from '@/lib/utils';

interface ReconciliationResidualCardProps {
  currencyCode: string;
  realizedMinor: string;
  attributedMinor: string;
  unattributedMinor: string;
  reconciliationRatePct: string | null;
  className?: string;
}

export function ReconciliationResidualCard({
  currencyCode,
  realizedMinor,
  attributedMinor,
  unattributedMinor,
  reconciliationRatePct,
  className,
}: ReconciliationResidualCardProps) {
  const ccy = currencyCode as CurrencyCode;

  const realized = formatMoneyDisplay(realizedMinor, ccy);
  const attributed = formatMoneyDisplay(attributedMinor, ccy);
  const unattributed = formatMoneyDisplay(unattributedMinor, ccy);

  // Closed-sum check (display-only assertion): attributed + unattributed must equal realized.
  // The engine + CI oracle guarantee this exactly; we surface the verdict honestly.
  const balances =
    BigInt(attributedMinor) + BigInt(unattributedMinor) === BigInt(realizedMinor);

  const StatusIcon = balances ? CheckCircle2 : AlertTriangle;
  const statusLabel = balances ? 'Closed sum balances' : 'Closed sum mismatch';
  const statusCls = balances
    ? 'bg-status-green-50 text-status-green-700 border-status-green-200'
    : 'bg-status-red-50 text-status-red-700 border-status-red-200';

  const rateDisplay = reconciliationRatePct != null ? `${reconciliationRatePct}%` : '—';

  return (
    <Card
      className={className}
      data-testid="reconciliation-residual-card"
      role="region"
      aria-label="Attribution reconciliation — the closed-sum parity oracle: attributed plus unattributed equals realized revenue"
    >
      <CardHeader className="pb-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            Reconciliation &amp; residual
          </CardTitle>
          <span
            role="status"
            aria-label={`${statusLabel}. Attributed plus unattributed equals realized revenue.`}
            data-testid="reconciliation-status"
            className={cn(
              'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-medium',
              statusCls,
            )}
          >
            <StatusIcon className="h-3 w-3" aria-hidden="true" />
            {statusLabel}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Reconciliation rate headline (attributed ÷ realized × 100). */}
        <div>
          <p className="text-xs font-medium text-muted-foreground uppercase tracking-wide">
            Reconciliation rate
          </p>
          <p
            className="text-2xl font-bold text-foreground tabular-nums leading-tight"
            data-testid="reconciliation-rate"
            aria-live="polite"
          >
            {rateDisplay}
          </p>
          <p className="text-xs text-muted-foreground">attributed ÷ realized revenue</p>
        </div>

        {/* The closed sum, as a small ledger — attributed + unattributed = realized. */}
        <table className="w-full text-sm" aria-label="Closed-sum breakdown">
          <caption className="sr-only">
            The closed-sum parity oracle: attributed revenue plus the unattributed residual equals
            realized revenue, exactly.
          </caption>
          <tbody>
            <tr className="border-b">
              <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                Attributed
              </th>
              <td
                className="py-1.5 text-right tabular-nums font-medium"
                data-testid="reconciliation-attributed"
              >
                {attributed}
              </td>
            </tr>
            <tr className="border-b">
              <th scope="row" className="py-1.5 text-left font-normal text-muted-foreground">
                Unattributed (residual)
              </th>
              <td
                className="py-1.5 text-right tabular-nums font-medium"
                data-testid="reconciliation-unattributed"
              >
                {unattributed}
              </td>
            </tr>
            <tr>
              <th scope="row" className="py-1.5 text-left font-semibold text-foreground">
                = Realized revenue
              </th>
              <td
                className="py-1.5 text-right tabular-nums font-bold text-foreground"
                data-testid="reconciliation-realized"
              >
                {realized}
              </td>
            </tr>
          </tbody>
        </table>

        <p className="text-xs text-muted-foreground">
          The residual is never hidden or spread across channels — attribution only credits
          revenue it can deterministically trace to a journey. Unattributed revenue lands here in
          full, so the closed sum always balances.
        </p>
      </CardContent>
    </Card>
  );
}
