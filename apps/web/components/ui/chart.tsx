/**
 * shadcn chart primitive — thin wrapper around Recharts.
 * Provides ChartContainer (CSS var color injection), ChartTooltip, ChartTooltipContent.
 * Chart colors come from CSS variables (--chart-1..5) defined in globals.css.
 *
 * A11y: chart SVG containers carry role="img" + aria-label; data tables are the
 * authoritative screen-reader fallback (rendered alongside via VisuallyHidden).
 */

'use client';

import * as React from 'react';
import { Tooltip, TooltipProps } from 'recharts';
import { cn } from '@/lib/utils';

// ── Chart config type ──────────────────────────────────────────────────────────

export type ChartConfig = {
  [key: string]: {
    label: string;
    color?: string;
  };
};

// ── Context ────────────────────────────────────────────────────────────────────

type ChartContextValue = {
  config: ChartConfig;
};

const ChartContext = React.createContext<ChartContextValue | null>(null);

function useChartContext() {
  const ctx = React.useContext(ChartContext);
  if (!ctx) throw new Error('useChartContext must be used inside ChartContainer');
  return ctx;
}

// ── CSS var helpers ────────────────────────────────────────────────────────────

/**
 * Returns a CSS variable string for a chart color key.
 * Colors declared in config.{key}.color override; else falls through to --chart-N.
 */
export function chartColor(key: string, config: ChartConfig, index: number): string {
  return config[key]?.color ?? `hsl(var(--chart-${index + 1}))`;
}

// ── ChartContainer ─────────────────────────────────────────────────────────────

interface ChartContainerProps {
  config: ChartConfig;
  children: React.ReactNode;
  className?: string;
  /** a11y: describes the chart for screen readers */
  'aria-label'?: string;
}

/**
 * ChartContainer — injects CSS color variables into the chart DOM context.
 * Wraps the Recharts ResponsiveContainer + injects --color-{key} CSS vars
 * so chart fills/strokes can use var(--color-realized) etc.
 */
export function ChartContainer({
  config,
  children,
  className,
  'aria-label': ariaLabel,
}: ChartContainerProps) {
  // Build CSS custom properties from config
  const styleVars = Object.entries(config).reduce<Record<string, string>>(
    (acc, [key, value], i) => {
      acc[`--color-${key}`] = value.color ?? `hsl(var(--chart-${i + 1}))`;
      return acc;
    },
    {},
  );

  return (
    <ChartContext.Provider value={{ config }}>
      <div
        className={cn('w-full', className)}
        style={styleVars as React.CSSProperties}
        role="img"
        aria-label={ariaLabel ?? 'Chart'}
      >
        {children}
      </div>
    </ChartContext.Provider>
  );
}

// ── ChartTooltip ───────────────────────────────────────────────────────────────

export { Tooltip as ChartTooltip };

// ── ChartTooltipContent ────────────────────────────────────────────────────────

interface ChartTooltipContentProps {
  active?: boolean;
  payload?: Array<{
    name?: string;
    value?: number | string;
    color?: string;
    dataKey?: string;
    /** Recharts attaches the full data row here — used by formatters to read raw fields. */
    payload?: Record<string, unknown>;
  }>;
  label?: string;
  labelFormatter?: (label: string) => string;
  /**
   * Receives the value, the series key, and the FULL Recharts entry (incl. `.payload`,
   * the raw data row) so formatters can read exact raw fields (e.g. minor-unit strings)
   * instead of matching back by display value.
   */
  formatter?: (
    value: number | string,
    name: string,
    entry: { value?: number | string; dataKey?: string; payload?: Record<string, unknown> },
  ) => string;
  className?: string;
}

export function ChartTooltipContent({
  active,
  payload,
  label,
  labelFormatter,
  formatter,
  className,
}: ChartTooltipContentProps) {
  const { config } = useChartContext();

  if (!active || !payload?.length) return null;

  const displayLabel = labelFormatter ? labelFormatter(label ?? '') : label;

  return (
    <div
      className={cn(
        'rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-md',
        className,
      )}
      role="status"
      aria-live="polite"
    >
      {displayLabel && (
        <p className="mb-1.5 font-medium text-foreground">{displayLabel}</p>
      )}
      <ul className="space-y-1">
        {payload.map((entry, i) => {
          const key = entry.dataKey ?? entry.name ?? `item-${i}`;
          const cfgEntry = config[key];
          const displayName = cfgEntry?.label ?? entry.name ?? key;
          const displayValue = formatter
            ? formatter(entry.value ?? 0, key, entry)
            : String(entry.value ?? 0);
          const color = entry.color ?? cfgEntry?.color ?? `hsl(var(--chart-${i + 1}))`;
          return (
            <li key={key} className="flex items-center gap-2">
              <span
                className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
                style={{ backgroundColor: color }}
                aria-hidden="true"
              />
              <span className="text-muted-foreground">{displayName}</span>
              <span className="ml-auto font-medium tabular-nums text-foreground">
                {displayValue}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

// ── ChartLegendContent ─────────────────────────────────────────────────────────

interface ChartLegendContentProps {
  payload?: Array<{
    value?: string;
    color?: string;
    dataKey?: string;
  }>;
  className?: string;
}

export function ChartLegendContent({ payload, className }: ChartLegendContentProps) {
  const { config } = useChartContext();
  if (!payload?.length) return null;

  return (
    <ul className={cn('flex flex-wrap items-center gap-4 text-xs', className)} role="list">
      {payload.map((entry, i) => {
        const key = entry.dataKey ?? entry.value ?? `item-${i}`;
        const cfgEntry = config[key];
        const label = cfgEntry?.label ?? entry.value ?? key;
        const color = entry.color ?? cfgEntry?.color ?? `hsl(var(--chart-${i + 1}))`;
        return (
          <li key={key} className="flex items-center gap-1.5">
            <span
              className="inline-block h-2.5 w-2.5 shrink-0 rounded-[2px]"
              style={{ backgroundColor: color }}
              aria-hidden="true"
            />
            <span className="text-muted-foreground">{label}</span>
          </li>
        );
      })}
    </ul>
  );
}
