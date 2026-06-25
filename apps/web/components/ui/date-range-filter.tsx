'use client';

/**
 * DateRangeFilter — the shared analytics range control: quick presets (7 / 30 / 90 days,
 * or whatever the page passes) PLUS a "Custom" option that reveals two native date inputs
 * (from / to). It is the ONE place range selection lives so every records page behaves the
 * same, and it emits an explicit { from, to } ISO date pair (YYYY-MM-DD) so the caller's BFF
 * hook can query a real bounded window — never a float, never a client-side re-derivation of
 * money/metrics.
 *
 * Zero-dep: uses the platform <input type="date"> (accessible, locale-aware, keyboard-native)
 * rather than a bespoke calendar — matching the repo's lean primitive style.
 *
 * Controlled: the caller owns the DateRange value. `key` is the active preset key, or 'custom'
 * when the user picked explicit dates; presets stay a fast path and custom is opt-in.
 *
 * A11y: a labelled radiogroup of preset chips + two labelled date inputs; the custom panel is
 * only rendered (and focusable) when active. Selection is text+state, never colour-only.
 */

import * as React from 'react';
import { CalendarDays } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Input } from '@/components/ui/input';

export interface RangePreset {
  /** Stable key (e.g. '7', '30', '90'). */
  readonly key: string;
  /** Visible label (e.g. 'Last 7 days'). */
  readonly label: string;
  /** Window length in days. */
  readonly days: number;
}

export interface DateRange {
  /** Inclusive start date, YYYY-MM-DD. */
  readonly from: string;
  /** Inclusive end date, YYYY-MM-DD. */
  readonly to: string;
  /** The active preset key, or 'custom' when explicit dates were chosen. */
  readonly key: string;
}

export const DEFAULT_RANGE_PRESETS: readonly RangePreset[] = [
  { key: '7', label: 'Last 7 days', days: 7 },
  { key: '30', label: 'Last 30 days', days: 30 },
  { key: '90', label: 'Last 90 days', days: 90 },
];

/** Today as YYYY-MM-DD (local). */
function today(): string {
  return new Date().toISOString().split('T')[0] as string;
}

/** The { from, to } window for a preset's day count, ending today. */
export function rangeForDays(days: number): { from: string; to: string } {
  const to = today();
  const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000)
    .toISOString()
    .split('T')[0] as string;
  return { from, to };
}

/** Build the initial DateRange for a preset key (defaults to the middle preset). */
export function initialRange(
  presets: readonly RangePreset[] = DEFAULT_RANGE_PRESETS,
  key?: string,
): DateRange {
  const preset = presets.find((p) => p.key === key) ?? presets[Math.min(1, presets.length - 1)] ?? presets[0];
  const safe = preset ?? { key: '30', label: 'Last 30 days', days: 30 };
  return { ...rangeForDays(safe.days), key: safe.key };
}

export interface DateRangeFilterProps {
  value: DateRange;
  onChange: (next: DateRange) => void;
  presets?: readonly RangePreset[];
  /** Hide the Custom option (e.g. where a custom window is not yet supported by the hook). */
  disableCustom?: boolean;
  className?: string;
  /** Accessible label for the control. */
  'aria-label'?: string;
}

const CHIP_BASE =
  'cursor-pointer rounded px-3 py-1 text-xs font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

export function DateRangeFilter({
  value,
  onChange,
  presets = DEFAULT_RANGE_PRESETS,
  disableCustom = false,
  className,
  'aria-label': ariaLabel = 'Date range',
}: DateRangeFilterProps) {
  const isCustom = value.key === 'custom';

  function pickPreset(p: RangePreset) {
    onChange({ ...rangeForDays(p.days), key: p.key });
  }

  function pickCustom() {
    // Seed custom with the current window so the inputs start populated.
    onChange({ from: value.from, to: value.to, key: 'custom' });
  }

  function setFrom(from: string) {
    if (!from) return;
    // Keep from <= to.
    const to = from > value.to ? from : value.to;
    onChange({ from, to, key: 'custom' });
  }

  function setTo(to: string) {
    if (!to) return;
    const from = to < value.from ? to : value.from;
    onChange({ from, to, key: 'custom' });
  }

  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <div
        className="flex flex-wrap gap-1 rounded-md border bg-card p-0.5 w-fit"
        role="radiogroup"
        aria-label={ariaLabel}
      >
        {presets.map((p) => {
          const active = !isCustom && value.key === p.key;
          return (
            <button
              key={p.key}
              type="button"
              role="radio"
              aria-checked={active}
              onClick={() => pickPreset(p)}
              className={cn(
                CHIP_BASE,
                active
                  ? 'bg-secondary text-secondary-foreground'
                  : 'bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
              )}
            >
              {p.label}
            </button>
          );
        })}
        {!disableCustom && (
          <button
            type="button"
            role="radio"
            aria-checked={isCustom}
            onClick={pickCustom}
            className={cn(
              CHIP_BASE,
              'inline-flex items-center gap-1',
              isCustom
                ? 'bg-secondary text-secondary-foreground'
                : 'bg-card text-foreground hover:bg-accent hover:text-accent-foreground',
            )}
          >
            <CalendarDays className="size-3.5" aria-hidden="true" />
            Custom
          </button>
        )}
      </div>

      {isCustom && !disableCustom && (
        <div className="flex items-center gap-2" aria-label="Custom date range">
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="sr-only">From</span>
            <Input
              type="date"
              value={value.from}
              max={value.to || today()}
              onChange={(e) => setFrom(e.target.value)}
              className="h-8 w-[9.5rem] text-xs"
              aria-label="From date"
            />
          </label>
          <span className="text-xs text-muted-foreground" aria-hidden="true">
            →
          </span>
          <label className="flex items-center gap-1 text-xs text-muted-foreground">
            <span className="sr-only">To</span>
            <Input
              type="date"
              value={value.to}
              min={value.from}
              max={today()}
              onChange={(e) => setTo(e.target.value)}
              className="h-8 w-[9.5rem] text-xs"
              aria-label="To date"
            />
          </label>
        </div>
      )}
    </div>
  );
}
