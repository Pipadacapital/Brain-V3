'use client';

/**
 * DqGradeMatrix — per-category × per-target latest dq grade matrix.
 *
 * Rendered as a real semantic <table> (row/column headers + per-cell aria-label),
 * so the verdict is fully readable by a screen reader and is never colour-only
 * (accessibility skill §charts-must-have-a-screen-reader-fallback / §status-never-colour-only).
 *
 * Reads grades the metric-engine/BFF computed (DqGradeCell[]); the UI never derives a
 * grade or queries dq_check_result.
 */

import * as React from 'react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { DqGradeBadge } from '@/components/analytics/dq-status';
import type { DqGradeCell, DqCheckCategory } from '@/lib/api/types';

const CATEGORY_LABEL: Record<DqCheckCategory, string> = {
  freshness: 'Freshness',
  completeness: 'Completeness',
  schema_validity: 'Schema validity',
  reconciliation: 'Reconciliation',
};

const CATEGORY_ORDER: DqCheckCategory[] = [
  'freshness',
  'completeness',
  'schema_validity',
  'reconciliation',
];

interface DqGradeMatrixProps {
  cells: DqGradeCell[];
}

export function DqGradeMatrix({ cells }: DqGradeMatrixProps) {
  // Distinct targets (rows), preserving first-seen order.
  const targets: string[] = [];
  for (const c of cells) {
    if (!targets.includes(c.target)) targets.push(c.target);
  }

  // Index by target → category → cell for O(1) lookup.
  const byTargetCategory = new Map<string, Map<DqCheckCategory, DqGradeCell>>();
  for (const c of cells) {
    let m = byTargetCategory.get(c.target);
    if (!m) {
      m = new Map();
      byTargetCategory.set(c.target, m);
    }
    m.set(c.category, c);
  }

  // Only render category columns that have at least one graded cell.
  const activeCategories = CATEGORY_ORDER.filter((cat) =>
    cells.some((c) => c.category === cat),
  );

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Quality grades by table &amp; check
        </CardTitle>
      </CardHeader>
      <CardContent>
        <div className="overflow-x-auto">
          <table
            className="w-full border-collapse text-sm"
            data-testid="dq-grade-matrix"
          >
            <caption className="sr-only">
              Data-quality letter grades for each table by check category. Each cell shows
              the latest grade and whether the check is passing.
            </caption>
            <thead>
              <tr className="border-b border-border">
                <th scope="col" className="py-2 pr-4 text-left font-medium text-muted-foreground">
                  Table
                </th>
                {activeCategories.map((cat) => (
                  <th
                    key={cat}
                    scope="col"
                    className="px-3 py-2 text-left font-medium text-muted-foreground"
                  >
                    {CATEGORY_LABEL[cat]}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {targets.map((target) => {
                const row = byTargetCategory.get(target);
                return (
                  <tr key={target} className="border-b border-border/50">
                    <th
                      scope="row"
                      className="py-2.5 pr-4 text-left font-mono text-xs font-medium text-foreground"
                    >
                      {target}
                    </th>
                    {activeCategories.map((cat) => {
                      const cell = row?.get(cat);
                      if (!cell) {
                        return (
                          <td
                            key={cat}
                            className="px-3 py-2.5 text-muted-foreground/50"
                            aria-label={`${CATEGORY_LABEL[cat]} for ${target}: not checked`}
                          >
                            —
                          </td>
                        );
                      }
                      return (
                        <td
                          key={cat}
                          className="px-3 py-2.5"
                          aria-label={`${CATEGORY_LABEL[cat]} for ${target}: grade ${cell.grade}, ${cell.passing ? 'passing' : 'failing'}. Observed ${cell.observed}, threshold ${cell.threshold}.`}
                        >
                          <span className="flex items-center gap-2">
                            <DqGradeBadge grade={cell.grade} passing={cell.passing} />
                            <span className="text-xs text-muted-foreground tabular-nums">
                              {cell.observed}
                              <span className="text-muted-foreground/50">
                                {' '}
                                / {cell.threshold}
                              </span>
                            </span>
                          </span>
                        </td>
                      );
                    })}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </CardContent>
    </Card>
  );
}
