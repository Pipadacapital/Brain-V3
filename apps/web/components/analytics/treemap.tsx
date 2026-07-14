'use client';

/**
 * Treemap — category → value as area-proportional rectangles, e.g. revenue by
 * category/product/channel. Each cell's AREA is its share of the whole, so a glance
 * ranks the contributors; the label + value are printed inside every cell.
 *
 * Conventions mirror Sparkline / CohortHeatmap:
 *   - Store-agnostic: it never fetches, it only renders the `items` it's given. Build
 *     them from a breakdown hook (category → value in a display magnitude; money stays
 *     minor-unit-safe upstream — chart a pre-divided magnitude, never re-derive a figure).
 *   - Inline SVG, NO heavy dependency — a self-contained squarified layout (Bruls et al.)
 *     so cells stay close to square and readable.
 *   - Themeable: cell colour defaults to the chart CSS vars (hsl(var(--chart-N))) and an
 *     item may override via `color`.
 *   - A11y (accessibility skill §status-never-colour-only): colour is NOT the sole carrier
 *     — every cell prints its label + value as TEXT (hidden only when the cell is too small,
 *     where a <title> tooltip + the SR table still carry it). Each cell carries an aria-label;
 *     a visually-hidden table lists every category for screen readers.
 *   - Honest empty: no items (or all non-positive) → EmptyState fallback, never a single
 *     fabricated block.
 */

import * as React from 'react';
import { LayoutGrid } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';

export interface TreemapItem {
  /** Stable id; falls back to `label` for the React key. */
  id?: string;
  /** Human label rendered in the cell + the SR-table row. */
  label: string;
  /** Magnitude — drives the cell area. Non-positive items are dropped. */
  value: number;
  /** Optional colour override (any CSS colour). Defaults to a cycling chart var. */
  color?: string;
}

export interface TreemapProps {
  /** Categories to lay out. Empty / all-non-positive → EmptyState fallback. */
  items: TreemapItem[];
  /** SVG viewport width in px. Default 640. */
  width?: number;
  /** SVG viewport height in px. Default 320. */
  height?: number;
  /** Format a value for display. Default `toLocaleString()`. */
  valueFormat?: (value: number) => string;
  isLoading?: boolean;
  /** Summary read by screen readers + used as the SVG aria-label / EmptyState context. */
  caption?: string;
  className?: string;
  'data-testid'?: string;
}

const CHART_VARS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

interface Cell {
  item: TreemapItem;
  color: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface AreaItem {
  item: TreemapItem;
  color: string;
  area: number;
}

/** Worst aspect ratio in a row given the side length it stacks along. */
function worst(row: AreaItem[], side: number): number {
  if (row.length === 0 || side <= 0) return Infinity;
  let sum = 0;
  let max = -Infinity;
  let min = Infinity;
  for (const r of row) {
    sum += r.area;
    if (r.area > max) max = r.area;
    if (r.area < min) min = r.area;
  }
  const s2 = sum * sum;
  return Math.max((side * side * max) / s2, s2 / (side * side * min));
}

/** Place one finished row along the short side of `box`; returns the remaining box. */
function layoutRow(row: AreaItem[], box: Box, out: Cell[]): Box {
  const sum = row.reduce((a, r) => a + r.area, 0);
  if (box.w >= box.h) {
    const rowW = sum / box.h;
    let y = box.y;
    for (const r of row) {
      const h = r.area / rowW;
      out.push({ item: r.item, color: r.color, x: box.x, y, w: rowW, h });
      y += h;
    }
    return { x: box.x + rowW, y: box.y, w: box.w - rowW, h: box.h };
  }
  const rowH = sum / box.w;
  let x = box.x;
  for (const r of row) {
    const w = r.area / rowH;
    out.push({ item: r.item, color: r.color, x, y: box.y, w, h: rowH });
    x += w;
  }
  return { x: box.x, y: box.y + rowH, w: box.w, h: box.h - rowH };
}

/** Squarified treemap (Bruls, Huizing, van Wijk). Areas must already sum to box area. */
function squarify(areas: AreaItem[], box: Box): Cell[] {
  const out: Cell[] = [];
  const queue = [...areas];
  let current: Box = box;
  let row: AreaItem[] = [];

  while (queue.length > 0) {
    const next = queue[0];
    if (!next) break; // unreachable: queue.length > 0, but keeps indexed access checked
    const side = Math.min(current.w, current.h);
    if (row.length === 0 || worst(row, side) >= worst([...row, next], side)) {
      row.push(next);
      queue.shift();
    } else {
      current = layoutRow(row, current, out);
      row = [];
    }
  }
  if (row.length > 0) layoutRow(row, current, out);
  return out;
}

export function Treemap({
  items,
  width = 640,
  height = 320,
  valueFormat = (v) => v.toLocaleString(),
  isLoading = false,
  caption = 'Treemap',
  className,
  'data-testid': testId,
}: TreemapProps) {
  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label={`${caption} — loading`}>
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    );
  }

  const clean = (items ?? []).filter((it) => Number.isFinite(it.value) && it.value > 0);

  if (clean.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No breakdown yet"
          description="The treemap appears once there are categories with value to compare by size."
          icon={<LayoutGrid className="h-8 w-8" />}
        />
      </div>
    );
  }

  // Largest first → the squarified layout keeps big cells closest to square.
  const sorted = [...clean].sort((a, b) => b.value - a.value);
  const total = sorted.reduce((a, it) => a + it.value, 0);
  const boxArea = width * height;

  const areas: AreaItem[] = sorted.map((item, i) => ({
    item,
    color: item.color ?? CHART_VARS[i % CHART_VARS.length]!, // modulo keeps the index in bounds
    area: (item.value / total) * boxArea,
  }));

  const cells = squarify(areas, { x: 0, y: 0, w: width, h: height });

  return (
    <div className={cn('w-full', className)} data-testid={testId}>
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        className="text-foreground"
        role="img"
        aria-label={caption}
        preserveAspectRatio="xMidYMid meet"
      >
        {cells.map((c, i) => {
          const valueText = valueFormat(c.item.value);
          // Show in-cell text only when the cell is big enough to hold it legibly;
          // otherwise the <title> tooltip + the SR table still carry the meaning.
          const showLabel = c.w >= 56 && c.h >= 30;
          const showValue = showLabel && c.h >= 44;
          return (
            <g key={c.item.id ?? c.item.label} aria-label={`${c.item.label}: ${valueText}`}>
              <rect
                x={c.x}
                y={c.y}
                width={Math.max(0, c.w - 2)}
                height={Math.max(0, c.h - 2)}
                rx={3}
                fill={c.color}
                fillOpacity={0.85}
              >
                <title>{`${c.item.label}: ${valueText}`}</title>
              </rect>
              {showLabel && (
                <text
                  x={c.x + 8}
                  y={c.y + 18}
                  className="text-[11px] font-medium"
                  fill="hsl(var(--background))"
                  stroke="hsl(var(--foreground))"
                  strokeWidth={2}
                  paintOrder="stroke"
                >
                  {c.item.label}
                </text>
              )}
              {showValue && (
                <text
                  x={c.x + 8}
                  y={c.y + 34}
                  className="text-[10px] tabular-nums"
                  fill="hsl(var(--background))"
                  stroke="hsl(var(--foreground))"
                  strokeWidth={2}
                  paintOrder="stroke"
                >
                  {valueText}
                </text>
              )}
            </g>
          );
        })}
      </svg>

      {/* Screen-reader-only enumeration — colour-independent, ordered by value. */}
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">Category</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {sorted.map((it) => (
            <tr key={it.id ?? it.label}>
              <td>{it.label}</td>
              <td>{valueFormat(it.value)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
