'use client';

/**
 * Sparkline — a tiny, label-less inline SVG line/area chart for a short numeric
 * series (typically a last-7d trend beside a KPI).
 *
 * Conventions mirror KpiTile / TrendChart:
 *   - Money/values are NOT formatted here — pass a plain number[] (the caller
 *     converts minor-unit strings to a display magnitude before charting; a
 *     sparkline only encodes SHAPE, never an exact figure).
 *   - Themeable: the line + area inherit `currentColor`, so set the colour with a
 *     text-* utility on the parent (e.g. <span className="text-status-green-700">).
 *   - A11y: role="img" + a required aria-label carrying the trend in words
 *     (accessibility skill §non-text-content) — the SVG glyph itself is aria-hidden.
 *   - Honest empty: with < 2 points there's no trend to draw → renders an em-dash,
 *     never a flat fabricated baseline.
 *
 * No axes, ticks, labels, tooltips, or animation — this is a glanceable primitive.
 */

import * as React from 'react';
import { cn } from '@/lib/utils';

export interface SparklineProps {
  /** The series to plot, oldest → newest. Needs ≥ 2 finite points to draw. */
  data: number[];
  /** SVG viewport width in px. Default 80. */
  width?: number;
  /** SVG viewport height in px. Default 24. */
  height?: number;
  /** Line stroke width in px. Default 1.5. */
  strokeWidth?: number;
  /** Fill a faint area under the line. Default true. */
  area?: boolean;
  /**
   * REQUIRED accessible label describing the trend in words, e.g.
   * "Revenue, last 7 days, trending up". The SVG is exposed as a single image.
   */
  ariaLabel: string;
  className?: string;
  'data-testid'?: string;
}

export function Sparkline({
  data,
  width = 80,
  height = 24,
  strokeWidth = 1.5,
  area = true,
  ariaLabel,
  className,
  'data-testid': testId,
}: SparklineProps) {
  // Honest empty: a sparkline needs at least two finite points to show a trend.
  // With fewer, we render an em-dash instead of a flat fabricated baseline.
  const points = data.filter((n) => Number.isFinite(n));
  if (points.length < 2) {
    return (
      <span
        className={cn('inline-block text-sm text-muted-foreground tabular-nums', className)}
        data-testid={testId}
        aria-label={`${ariaLabel}: no trend data`}
        role="img"
      >
        &mdash;
      </span>
    );
  }

  const min = Math.min(...points);
  const max = Math.max(...points);
  const span = max - min;

  // Inset by half the stroke so the line never clips at the top/bottom edges.
  const pad = strokeWidth;
  const innerW = width - pad * 2;
  const innerH = height - pad * 2;

  const stepX = innerW / (points.length - 1);
  // A flat series (span 0) sits on the vertical midline rather than the edge.
  const yFor = (v: number): number =>
    span === 0 ? pad + innerH / 2 : pad + innerH - ((v - min) / span) * innerH;

  const coords = points.map((v, i) => ({ x: pad + i * stepX, y: yFor(v) }));
  const linePath = coords
    .map((p, i) => `${i === 0 ? 'M' : 'L'}${p.x.toFixed(2)},${p.y.toFixed(2)}`)
    .join(' ');
  // Close the path down to the baseline and back for the filled area.
  const areaPath =
    `${linePath} L${coords[coords.length - 1].x.toFixed(2)},${(height - pad).toFixed(2)}` +
    ` L${coords[0].x.toFixed(2)},${(height - pad).toFixed(2)} Z`;

  return (
    <svg
      width={width}
      height={height}
      viewBox={`0 0 ${width} ${height}`}
      className={cn('overflow-visible text-foreground', className)}
      role="img"
      aria-label={ariaLabel}
      data-testid={testId}
      preserveAspectRatio="none"
    >
      {area && <path d={areaPath} fill="currentColor" fillOpacity={0.12} stroke="none" />}
      <path
        d={linePath}
        fill="none"
        stroke="currentColor"
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
