'use client';

/**
 * Sankey — a flow diagram for value moving between stages, e.g. channel → revenue
 * (paid · Meta → Revenue, Direct → Revenue, …). Bands are sized by their value, so
 * the thickness of each flow IS the magnitude.
 *
 * Conventions mirror Sparkline / CohortHeatmap:
 *   - Store-agnostic: it never fetches, it only renders the `nodes`/`links` it's
 *     given. Build the graph from a flow hook (channel contribution → links with
 *     value in a display magnitude; revenue stays minor-unit-safe upstream, only a
 *     pre-divided magnitude is charted here, never re-derived to an exact figure).
 *   - Inline SVG, NO heavy dependency (no d3-sankey) — a self-contained layout.
 *   - Themeable: node/flow colour defaults to the chart CSS vars (hsl(var(--chart-N)))
 *     and a node may override via `color`; the SVG inherits `currentColor` for text.
 *   - A11y (accessibility skill §status-never-colour-only): every node prints its
 *     label + value as TEXT and every link prints its label + value, so the diagram
 *     is fully readable without colour. The SVG is one role="img" with a summary
 *     aria-label; a visually-hidden table lists every flow for screen readers.
 *   - Honest empty: no links (or no positive value) → EmptyState fallback, never a
 *     fabricated single bar.
 */

import * as React from 'react';
import { Workflow } from 'lucide-react';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { cn } from '@/lib/utils';

export interface SankeyNode {
  /** Stable id referenced by link.source / link.target. */
  id: string;
  /** Human label rendered beside the node (also the SR-table row label). */
  label: string;
  /** Optional colour override (any CSS colour). Defaults to a cycling chart var. */
  color?: string;
}

export interface SankeyLink {
  /** Source node id. */
  source: string;
  /** Target node id. */
  target: string;
  /** Flow magnitude — drives band thickness. Non-positive links are dropped. */
  value: number;
  /** Optional label printed on the band (alongside the formatted value). */
  label?: string;
}

export interface SankeyProps {
  /** All nodes. Nodes unreferenced by any positive link are ignored in layout. */
  nodes: SankeyNode[];
  /** Directed flows. Empty / all-non-positive → EmptyState fallback. */
  links: SankeyLink[];
  /** SVG viewport width in px. Default 640. */
  width?: number;
  /** SVG viewport height in px. Default 320. */
  height?: number;
  /** Node bar thickness (horizontal extent) in px. Default 14. */
  nodeWidth?: number;
  /** Vertical gap between stacked nodes in a column, in px. Default 12. */
  nodePadding?: number;
  /** Format a flow/node value for display. Default `toLocaleString()`. */
  valueFormat?: (value: number) => string;
  isLoading?: boolean;
  /** Summary read by screen readers + used as the SVG aria-label / EmptyState context. */
  caption?: string;
  className?: string;
  'data-testid'?: string;
}

/** Cycling decorative palette — meaning is carried by label + value text, never colour. */
const CHART_VARS = [
  'hsl(var(--chart-1))',
  'hsl(var(--chart-2))',
  'hsl(var(--chart-3))',
  'hsl(var(--chart-4))',
  'hsl(var(--chart-5))',
];

interface PlacedNode {
  id: string;
  label: string;
  color: string;
  depth: number;
  x: number;
  y: number;
  h: number;
}

interface PlacedLink {
  link: SankeyLink;
  color: string;
  path: string;
  /** Mid-point of the band, for the on-flow label. */
  midX: number;
  midY: number;
}

export function Sankey({
  nodes,
  links,
  width = 640,
  height = 320,
  nodeWidth = 14,
  nodePadding = 12,
  valueFormat = (v) => v.toLocaleString(),
  isLoading = false,
  caption = 'Flow diagram',
  className,
  'data-testid': testId,
}: SankeyProps) {
  if (isLoading) {
    return (
      <div className={className} aria-busy="true" aria-label={`${caption} — loading`}>
        <Skeleton className="h-72 w-full rounded-lg" />
      </div>
    );
  }

  const cleanLinks = (links ?? []).filter(
    (l) => Number.isFinite(l.value) && l.value > 0 && l.source !== l.target,
  );

  if (cleanLinks.length === 0) {
    return (
      <div className={className}>
        <EmptyState
          title="No flows yet"
          description="The flow diagram appears once there is attributed value moving between stages to chart."
          icon={<Workflow className="h-8 w-8" />}
        />
      </div>
    );
  }

  // ---- Resolve nodes referenced by the surviving links -------------------------
  const nodeMeta = new Map(nodes.map((n, i) => [n.id, n]));
  const referenced = new Set<string>();
  cleanLinks.forEach((l) => {
    referenced.add(l.source);
    referenced.add(l.target);
  });
  const colorFor = (id: string): string => {
    const meta = nodeMeta.get(id);
    if (meta?.color) return meta.color;
    // Stable per-id hue by first-seen order.
    const idx = [...referenced].indexOf(id);
    return CHART_VARS[idx % CHART_VARS.length];
  };

  // ---- Assign a column (depth) to each node via longest-path relaxation ---------
  const depth = new Map<string, number>();
  referenced.forEach((id) => depth.set(id, 0));
  // Cap iterations to the node count so a cycle can't loop forever.
  for (let pass = 0; pass < referenced.size; pass++) {
    let changed = false;
    for (const l of cleanLinks) {
      const next = (depth.get(l.source) ?? 0) + 1;
      if (next > (depth.get(l.target) ?? 0)) {
        depth.set(l.target, next);
        changed = true;
      }
    }
    if (!changed) break;
  }
  const maxDepth = Math.max(...[...depth.values()]);

  // ---- Node value = max(incoming, outgoing) ------------------------------------
  const inSum = new Map<string, number>();
  const outSum = new Map<string, number>();
  cleanLinks.forEach((l) => {
    outSum.set(l.source, (outSum.get(l.source) ?? 0) + l.value);
    inSum.set(l.target, (inSum.get(l.target) ?? 0) + l.value);
  });
  const nodeValue = (id: string): number =>
    Math.max(inSum.get(id) ?? 0, outSum.get(id) ?? 0);

  // ---- Group by column ---------------------------------------------------------
  const columns: string[][] = Array.from({ length: maxDepth + 1 }, () => []);
  referenced.forEach((id) => columns[depth.get(id) ?? 0].push(id));
  // Stable vertical order within a column: highest value on top.
  columns.forEach((col) => col.sort((a, b) => nodeValue(b) - nodeValue(a)));

  // ---- Vertical scale (px per unit) so the fullest column fits ------------------
  const pad = 4; // outer inset
  const labelGap = 6;
  const innerH = height - pad * 2;
  let scale = Infinity;
  columns.forEach((col) => {
    if (col.length === 0) return;
    const total = col.reduce((a, id) => a + nodeValue(id), 0);
    if (total <= 0) return;
    const usable = innerH - nodePadding * (col.length - 1);
    scale = Math.min(scale, usable / total);
  });
  if (!Number.isFinite(scale) || scale <= 0) scale = 1;

  // ---- Horizontal placement ----------------------------------------------------
  const innerW = width - pad * 2;
  const colSpacing = maxDepth > 0 ? (innerW - nodeWidth) / maxDepth : 0;

  const placed = new Map<string, PlacedNode>();
  columns.forEach((col, d) => {
    const total = col.reduce((a, id) => a + nodeValue(id), 0);
    const colHeight = total * scale + nodePadding * (col.length - 1);
    let y = pad + (innerH - colHeight) / 2;
    const x = pad + d * colSpacing;
    col.forEach((id) => {
      const h = Math.max(1, nodeValue(id) * scale);
      placed.set(id, {
        id,
        label: nodeMeta.get(id)?.label ?? id,
        color: colorFor(id),
        depth: d,
        x,
        y,
        h,
      });
      y += h + nodePadding;
    });
  });

  // ---- Link bands --------------------------------------------------------------
  // Stack each node's links by the partner node's vertical position for clean ribbons.
  const outOffset = new Map<string, number>();
  const inOffset = new Map<string, number>();
  const ordered = [...cleanLinks].sort((a, b) => {
    const sa = placed.get(a.source)!.y;
    const sb = placed.get(b.source)!.y;
    if (sa !== sb) return sa - sb;
    return placed.get(a.target)!.y - placed.get(b.target)!.y;
  });

  const placedLinks: PlacedLink[] = ordered.map((l) => {
    const s = placed.get(l.source)!;
    const t = placed.get(l.target)!;
    const thick = Math.max(1, l.value * scale);
    const so = outOffset.get(l.source) ?? 0;
    const to = inOffset.get(l.target) ?? 0;
    outOffset.set(l.source, so + thick);
    inOffset.set(l.target, to + thick);

    const sx = s.x + nodeWidth;
    const tx = t.x;
    const sy0 = s.y + so;
    const ty0 = t.y + to;
    const sy1 = sy0 + thick;
    const ty1 = ty0 + thick;
    const cx = (sx + tx) / 2;

    const path =
      `M${sx},${sy0} C${cx},${sy0} ${cx},${ty0} ${tx},${ty0} ` +
      `L${tx},${ty1} C${cx},${ty1} ${cx},${sy1} ${sx},${sy1} Z`;

    return {
      link: l,
      color: colorFor(l.source),
      path,
      midX: cx,
      midY: (sy0 + ty1) / 2,
    };
  });

  const linkText = (l: SankeyLink): string =>
    l.label ? `${l.label} · ${valueFormat(l.value)}` : valueFormat(l.value);

  return (
    <div className={cn('w-full', className)} data-testid={testId}>
      <svg
        width="100%"
        viewBox={`0 0 ${width} ${height}`}
        className="overflow-visible text-foreground"
        role="img"
        aria-label={caption}
        preserveAspectRatio="xMidYMid meet"
      >
        {/* Flow bands (decorative — text below carries meaning). */}
        <g aria-hidden="true">
          {placedLinks.map((pl, i) => (
            <path
              key={i}
              d={pl.path}
              fill={pl.color}
              fillOpacity={0.35}
              stroke={pl.color}
              strokeOpacity={0.18}
            />
          ))}
        </g>

        {/* Node bars. */}
        <g aria-hidden="true">
          {[...placed.values()].map((n) => (
            <rect
              key={n.id}
              x={n.x}
              y={n.y}
              width={nodeWidth}
              height={n.h}
              rx={2}
              fill={n.color}
            />
          ))}
        </g>

        {/* Node labels (left-aligned for the first column, right-aligned for the last). */}
        <g aria-hidden="true" className="fill-foreground">
          {[...placed.values()].map((n) => {
            const atLast = n.depth === maxDepth;
            const tx = atLast ? n.x - labelGap : n.x + nodeWidth + labelGap;
            return (
              <text
                key={n.id}
                x={tx}
                y={n.y + n.h / 2}
                dominantBaseline="middle"
                textAnchor={atLast ? 'end' : 'start'}
                className="text-[11px] font-medium tabular-nums"
                fill="currentColor"
              >
                {n.label} · {valueFormat(nodeValue(n.id))}
              </text>
            );
          })}
        </g>

        {/* On-flow labels — label + value per link, with a paint-order halo for legibility. */}
        <g aria-hidden="true">
          {placedLinks.map((pl, i) => (
            <text
              key={i}
              x={pl.midX}
              y={pl.midY}
              dominantBaseline="middle"
              textAnchor="middle"
              className="text-[10px] tabular-nums"
              fill="hsl(var(--foreground))"
              stroke="hsl(var(--background))"
              strokeWidth={3}
              paintOrder="stroke"
            >
              {linkText(pl.link)}
            </text>
          ))}
        </g>
      </svg>

      {/* Screen-reader-only enumeration of every flow — colour-independent. */}
      <table className="sr-only">
        <caption>{caption}</caption>
        <thead>
          <tr>
            <th scope="col">From</th>
            <th scope="col">To</th>
            <th scope="col">Value</th>
          </tr>
        </thead>
        <tbody>
          {cleanLinks.map((l, i) => (
            <tr key={i}>
              <td>{nodeMeta.get(l.source)?.label ?? l.source}</td>
              <td>{nodeMeta.get(l.target)?.label ?? l.target}</td>
              <td>{linkText(l)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
