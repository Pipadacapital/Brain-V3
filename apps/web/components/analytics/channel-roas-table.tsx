'use client';

/**
 * ChannelRoasTable — per-channel unit economics: attributed revenue ÷ ad spend.
 *
 * This is what makes blended_roas PER-CHANNEL — it joins the attributed contribution
 * (Gold attribution credit ledger) with ad_spend_ledger over the BFF → metric-engine sole
 * read path (I-ST01 — the UI never queries the ledger/StarRocks). Same-currency only
 * (like blended_roas; multi-currency blending is an explicit non-goal).
 *
 * Money: attributed_minor / spend_minor are bigint minor-unit strings → formatMoneyDisplay
 * (locale-aware, never /100, never a hardcoded symbol). roas_ratio is the engine's EXACT
 * decimal string — rendered directly, NEVER re-divided with floats. When spend = 0 the
 * engine returns null and we render an honest "n/a" (no fabricated infinity).
 *
 * A11y: a real <table> with column headers (scope=col) and a per-channel icon+label cell
 * (channel meaning carried by icon + text, never colour). The ratio cell carries an
 * aria-label with the full verdict. A visible caption frames the unit-economics intent.
 */

import { TrendingUp } from 'lucide-react';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { ChannelRoasRow } from '@/lib/api/types';
import { channelMeta } from './channel-meta';

interface ChannelRoasTableProps {
  rows: ChannelRoasRow[];
  className?: string;
}

export function ChannelRoasTable({ rows, className }: ChannelRoasTableProps) {
  // Stable channel ordering (paid → owned → referral → direct).
  const ordered = [...rows].sort(
    (a, b) => channelMeta(a.channel).order - channelMeta(b.channel).order,
  );

  if (ordered.length === 0) {
    return (
      <p
        className="text-sm text-muted-foreground italic"
        role="status"
        data-testid="channel-roas-empty"
      >
        No channel ROAS yet — attribution or ad spend has no rows in this window.
      </p>
    );
  }

  return (
    <table
      className={className}
      data-testid="channel-roas-table"
      aria-label="Per-channel ROAS — attributed revenue divided by ad spend"
    >
      <caption className="sr-only">
        Channel ROAS = attributed revenue ÷ ad spend, per channel, for the selected attribution
        model. ROAS is null (n/a) when there is no ad spend for the channel.
      </caption>
      <thead>
        <tr className="border-b">
          <th scope="col" className="text-left font-medium text-muted-foreground pb-2">
            Channel
          </th>
          <th scope="col" className="text-right font-medium text-muted-foreground pb-2">
            Attributed revenue
          </th>
          <th scope="col" className="text-right font-medium text-muted-foreground pb-2">
            Ad spend
          </th>
          <th scope="col" className="text-right font-medium text-muted-foreground pb-2">
            ROAS
          </th>
        </tr>
      </thead>
      <tbody>
        {ordered.map((row) => {
          const meta = channelMeta(row.channel);
          const Icon = meta.icon;
          const ccy = row.currency_code as CurrencyCode;
          const attributed = formatMoneyDisplay(row.attributed_minor, ccy);
          const spend = formatMoneyDisplay(row.spend_minor, ccy);
          const ratioLabel =
            row.roas_ratio != null
              ? `${row.roas_ratio}x ROAS`
              : 'ROAS not available — no ad spend';
          return (
            <tr key={row.channel} className="border-b last:border-0">
              <td className="py-2 font-medium">
                <span className="inline-flex items-center gap-1.5">
                  <Icon className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                  {meta.label}
                </span>
              </td>
              <td className="py-2 text-right tabular-nums">{attributed}</td>
              <td className="py-2 text-right tabular-nums">{spend}</td>
              <td className="py-2 text-right tabular-nums font-medium" aria-label={ratioLabel}>
                {row.roas_ratio != null ? (
                  <span className="inline-flex items-center justify-end gap-1">
                    <TrendingUp className="h-3.5 w-3.5 text-muted-foreground" aria-hidden="true" />
                    {row.roas_ratio}x
                  </span>
                ) : (
                  <span className="text-muted-foreground italic">n/a</span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
