'use client';

/**
 * FoundationHealthCard — the dashboard's foundation-first surface (P1).
 *
 * Brain's spine starts at the data foundation: a brand must never land on empty/misleading charts.
 * This card answers "is my data foundation ready?" in one verdict (blocked → building → ready →
 * healthy), shows the progression checklist (what's done / what's left), and gives the single most
 * important next step. It leads the dashboard so health is the first thing the user sees, not zeros.
 */

import * as React from 'react';
import Link from 'next/link';
import { Check, Circle, ShieldCheck, ShieldAlert, Hourglass, Rocket } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFoundationHealth } from '@/lib/hooks/use-foundation-health';
import type { FoundationTier } from '@/lib/api/types';

const TIER_META: Record<
  FoundationTier,
  { label: string; icon: React.ComponentType<{ className?: string }>; chip: string; bar: string }
> = {
  blocked: { label: 'Blocked', icon: ShieldAlert, chip: 'bg-red-50 text-red-700', bar: 'bg-red-500' },
  building: { label: 'Building', icon: Hourglass, chip: 'bg-amber-50 text-amber-800', bar: 'bg-amber-500' },
  ready: { label: 'Ready', icon: Rocket, chip: 'bg-blue-50 text-blue-700', bar: 'bg-blue-500' },
  healthy: { label: 'Healthy', icon: ShieldCheck, chip: 'bg-emerald-50 text-emerald-700', bar: 'bg-emerald-500' },
};

export function FoundationHealthCard() {
  const { data, isLoading, error } = useFoundationHealth();

  if (isLoading) {
    return <Skeleton className="h-40 w-full" data-testid="foundation-health-loading" />;
  }
  // On error, fail quiet — the rest of the dashboard still renders; don't block the page.
  if (error || !data) return null;

  const meta = TIER_META[data.tier];
  const Icon = meta.icon;
  const doneCount = data.steps.filter((s) => s.done).length;
  const total = data.steps.length;
  const pct = total > 0 ? Math.round((doneCount / total) * 100) : 0;

  return (
    <Card data-testid="foundation-health-card">
      <CardHeader className="pb-3">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <CardTitle className="text-base">Data foundation</CardTitle>
            <p className="text-sm text-muted-foreground">{data.headline}</p>
          </div>
          <span
            className={`inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${meta.chip}`}
            role="status"
            aria-label={`Data foundation: ${meta.label}`}
          >
            <Icon className="h-3.5 w-3.5" aria-hidden="true" />
            {meta.label}
          </span>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Progress bar — honest "X of N foundations in place". */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Foundation setup</span>
            <span className="tabular-nums">
              {doneCount}/{total} complete
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className={`h-full rounded-full transition-all ${meta.bar}`} style={{ width: `${pct}%` }} />
          </div>
        </div>

        {/* Progression checklist — what's done, what's left. */}
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.steps.map((step) => (
            <li key={step.key} className="flex items-center gap-2 text-sm">
              {step.done ? (
                <Check className="h-4 w-4 shrink-0 text-emerald-600" aria-hidden="true" />
              ) : (
                <Circle className="h-4 w-4 shrink-0 text-muted-foreground/50" aria-hidden="true" />
              )}
              <span className={step.done ? 'text-foreground' : 'text-muted-foreground'}>{step.label}</span>
              <span className="sr-only">{step.done ? '— done' : '— not done'}</span>
            </li>
          ))}
        </ul>

        {/* The single most important next step. */}
        {data.next_action && (
          <div className="flex items-center justify-between gap-3 rounded-md border bg-muted/30 px-3 py-2">
            <span className="text-sm">
              <span className="font-medium">Next step: </span>
              {data.next_action.label}
            </span>
            <Button asChild size="sm">
              <Link href={data.next_action.href}>{data.next_action.label}</Link>
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
