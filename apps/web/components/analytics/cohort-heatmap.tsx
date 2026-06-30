'use client';

/**
 * CohortHeatmap — a classic cohort retention grid.
 *
 *   rows  = cohort (typically acquisition month)
 *   cols  = period N since acquisition (P0, P1, …)
 *   cell  = a percentage, shaded red → green by magnitude
 *
 * Conventions mirror TrendChart / ChannelRoasTable:
 *   - Props are shaped so the data can be built directly from the cohort-retention
 *     hook (useCohortRetention → AnalyticsCohortRetentionRow): map cohort_month →
 *     `label` and cohort_size → `size`, and project the period cells. The component
 *     is store-agnostic — it never fetches, it only renders the matrix it's given.
 *   - A11y (accessibility skill §status-never-colour-only): every cell prints its
 *     numeric value as TEXT, so the grid is fully readable without colour; the
 *     colour is a redundant cue. Each cell carries an aria-label with cohort +
 *     period + value, and the table has a caption.
 *   - Honest empty: with no rows (or state==='no_data' upstream) the caller passes
 *     an empty `rows` array → EmptyState fallback, never a fabricated grid.
 *
 * Percentages are pre-computed by the engine and passed as numbers (0..100) or null
 * for an honestly-missing cell (rendered as an em-dash, never a fabricated 0).
 */

import * as React from 'react';
import { Grid3x3 } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';

export interface CohortHeatmapCell {
  /** Period index since acquisition (0 = acquisition period). */
  period: number;
  /** Percentage 0..100, or null for an honestly-missing cell (→ em-dash). */
  value: number | null;
}

export interface CohortHeatmapRow {
  /** Cohort label — typically the acquisition month 'YYYY-MM'. */
  label: string;
  /** Optional cohort size, shown in a leading column when any row provides it. */
  size?: number | null;
  /** Cells across periods, left → right (period ascending). */
  cells: CohortHeatmapCell[];
}

export interface CohortHeatmapProps {
  /** One entry per cohort. Empty → EmptyState fallback. */
  rows: CohortHeatmapRow[];
  /** Column header labels keyed by period index; defaults to "P{n}". */
  periodLabels?: string[];
  /** Header for the leading cohort column. Default "Cohort". */
  cohortHeader?: string;
  /** Header for the size column. Default "Size". */
  sizeHeader?: string;
  isLoading?: boolean;
  /** Caption read by screen readers (also the EmptyState/aria context). */
  caption?: string;
  /**
   * Optional cell drill-down. When provided, every (non-empty) cell becomes an
   * activatable button that calls back with the cohort label + period index, so a
   * caller can open a per-cell drill-down (e.g. the customers inside that cohort cell).
   * Omitted → cells render as plain text exactly as before (back-compat).
   */
  onCellClick?: (cohortMonth: string, period: number) => void;
  /** The currently-selected cell (highlighted), as {label, period}. Drill-down only. */
  selectedCell?: { label: string; period: number } | null;
  className?: string;
  'data-testid'?: string;
}

/**
 * Map a 0..100 percentage to a red→amber→green background + a readable foreground.
 * Returns inline styles (HSL) so the ramp is continuous and theme-independent; the
 * value is ALSO printed as text, so colour is never the sole carrier of meaning.
 */
function cellStyle(value: number | null): React.CSSProperties {
  if (value === null || !Number.isFinite(value)) return {};
  const pct = Math.max(0, Math.min(100, value));
  // 0% → hue 0 (red), 100% → hue 140 (green).
  const hue = (pct / 100) * 140;
  return {
    backgroundColor: `hsl(${hue} 65% 45% / ${0.18 + (pct / 100) * 0.55})`,
    color: pct >= 55 ? 'hsl(0 0% 100%)' : 'hsl(var(--foreground))',
  };
}

function fmtPct(value: number | null): string {
  if (value === null || !Number.isFinite(value)) return '—';
  return `${value.toFixed(value % 1 === 0 ? 0 : 1)}%`;
}

export function CohortHeatmap({
  rows,
  periodLabels,
  cohortHeader = 'Cohort',
  sizeHeader = 'Size',
  isLoading = false,
  caption = 'Cohort retention heatmap',
  onCellClick,
  selectedCell = null,
  className,
  'data-testid': testId,
}: CohortHeatmapProps) {
  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label={`${caption} — loading`}>
        <Skeleton className="h-64 w-full rounded-lg" />
      </div>
    );
  }

  if (!rows || rows.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No cohorts yet"
          description="The cohort heatmap appears once acquisition cohorts have enough history to compare retention across periods."
          icon={<Grid3x3 className="h-8 w-8" />}
        />
      </div>
    );
  }

  const showSize = rows.some((r) => r.size != null);
  const periodCount = rows.reduce((max, r) => Math.max(max, r.cells.length), 0);
  const periods = Array.from({ length: periodCount }, (_, i) => i);
  const labelFor = (p: number): string => periodLabels?.[p] ?? `P${p}`;

  return (
    <div className={cn('w-full overflow-x-auto', className)} data-testid={testId}>
      <table className="w-full border-separate border-spacing-1 text-sm">
        <caption className="sr-only">{caption}</caption>
        <thead>
          <tr>
            <th
              scope="col"
              className="sticky left-0 bg-background px-2 py-1 text-left text-xs font-medium text-muted-foreground"
            >
              {cohortHeader}
            </th>
            {showSize && (
              <th scope="col" className="px-2 py-1 text-right text-xs font-medium text-muted-foreground">
                {sizeHeader}
              </th>
            )}
            {periods.map((p) => (
              <th
                key={p}
                scope="col"
                className="px-2 py-1 text-center text-xs font-medium text-muted-foreground tabular-nums"
              >
                {labelFor(p)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const byPeriod = new Map(row.cells.map((c) => [c.period, c.value]));
            return (
              <tr key={row.label}>
                <th
                  scope="row"
                  className="sticky left-0 bg-background px-2 py-1 text-left font-medium text-foreground tabular-nums whitespace-nowrap"
                >
                  {row.label}
                </th>
                {showSize && (
                  <td className="px-2 py-1 text-right text-muted-foreground tabular-nums">
                    {row.size != null ? row.size.toLocaleString('en-IN') : '—'}
                  </td>
                )}
                {periods.map((p) => {
                  const has = byPeriod.has(p);
                  const value = has ? (byPeriod.get(p) as number | null) : null;
                  const cellLabel = `${row.label}, ${labelFor(p)}: ${fmtPct(value)}`;
                  // Drill-down: a present cell becomes a button when onCellClick is wired.
                  const clickable = !!onCellClick && has;
                  const isSelected =
                    selectedCell != null && selectedCell.label === row.label && selectedCell.period === p;
                  return (
                    <td
                      key={p}
                      className={cn(
                        'rounded px-2 py-1 text-center font-medium tabular-nums',
                        clickable && 'p-0',
                        isSelected && 'ring-2 ring-ring ring-offset-1 ring-offset-background',
                      )}
                      style={clickable ? undefined : cellStyle(value)}
                      aria-label={clickable ? undefined : cellLabel}
                    >
                      {clickable ? (
                        <button
                          type="button"
                          onClick={() => onCellClick?.(row.label, p)}
                          aria-label={`${cellLabel} — view customers`}
                          aria-pressed={isSelected}
                          className="w-full rounded px-2 py-1 text-center font-medium tabular-nums transition-[filter] hover:brightness-110 focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          style={cellStyle(value)}
                        >
                          {fmtPct(value)}
                        </button>
                      ) : (
                        fmtPct(value)
                      )}
                    </td>
                  );
                })}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
