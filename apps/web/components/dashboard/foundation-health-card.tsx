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
import { SectionCard } from '@/components/ui/section-card';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import { MetricTitle } from '@/components/ui/metric-title';
import { Tooltip } from '@/components/ui/tooltip';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useFoundationHealth } from '@/lib/hooks/use-foundation-health';
import type { FoundationTier } from '@/lib/api/types';

const TIER_META: Record<
  FoundationTier,
  { label: string; icon: React.ComponentType<{ className?: string }>; tone: StatusTone; bar: string }
> = {
  blocked: { label: 'Needs attention', icon: ShieldAlert, tone: 'destructive', bar: 'bg-destructive' },
  building: { label: 'Setting up', icon: Hourglass, tone: 'warning', bar: 'bg-warning' },
  ready: { label: 'Ready', icon: Rocket, tone: 'info', bar: 'bg-info' },
  healthy: { label: 'Healthy', icon: ShieldCheck, tone: 'success', bar: 'bg-success' },
};

/**
 * Display-only rewording of the setup steps as actions a person takes (keyed on the step key;
 * the server label is the fallback for unknown keys). Each carries a one-sentence explanation.
 */
const STEP_DISPLAY: Record<string, { label: string; help: string }> = {
  commerce: {
    label: 'Connect your store',
    help: 'Link your store (like Shopify) so your orders and customers flow into Brain.',
  },
  pixel: {
    label: 'Install the Brain Pixel',
    help: 'Add the small tracking snippet to your storefront so shopper visits can be measured.',
  },
  first_event: {
    label: 'See your first data arrive',
    help: 'Check that your store has sent Brain its first visit or order.',
  },
  sync: {
    label: 'Start your first import',
    help: 'Kick off the initial sync that brings in your existing order history.',
  },
  fresh: {
    label: 'Keep data flowing',
    help: 'New orders and visits keep arriving on time, so your numbers stay current.',
  },
  trusted: {
    label: 'Reach trusted data quality',
    help: 'Brain has checked your data closely enough to trust the numbers it shows you.',
  },
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
    <SectionCard
      data-testid="foundation-health-card"
      title={
        <MetricTitle
          label="Data foundation"
          help="Everything Brain needs before your numbers can be trusted — your store connection, tracking pixel, and first data."
        />
      }
      description={data.headline}
      actions={
        <StatusBadge tone={meta.tone} aria-label={`Data foundation: ${meta.label}`}>
          <Icon className="h-3.5 w-3.5" aria-hidden="true" />
          {meta.label}
        </StatusBadge>
      }
      className="h-full"
    >
      <div className="space-y-5">
        {/* Progress bar — honest "X of N foundations in place". */}
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-muted-foreground">
            <span>Setup progress</span>
            <span className="tabular-nums">
              {doneCount} of {total} done
            </span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-muted" aria-hidden="true">
            <div className={`h-full rounded-full transition-all ${meta.bar}`} style={{ width: `${pct}%` }} />
          </div>
        </div>

        {/* Progression checklist — what's done, what's left. */}
        <ul className="grid gap-2 sm:grid-cols-2">
          {data.steps.map((step) => {
            const display = STEP_DISPLAY[step.key];
            const label = display?.label ?? step.label;
            const row = (
              <>
                {step.done ? (
                  <Check className="h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                ) : (
                  <Circle className="h-4 w-4 shrink-0 text-muted-foreground/40" aria-hidden="true" />
                )}
                <span className={step.done ? 'text-foreground' : 'text-muted-foreground'}>{label}</span>
                <span className="sr-only">{step.done ? '— done' : '— not done'}</span>
              </>
            );
            return (
              <li key={step.key} className="flex items-center gap-2 text-sm">
                {display ? (
                  <Tooltip content={display.help}>
                    <span tabIndex={0} className="flex items-center gap-2" aria-label={`${label}. ${display.help}`}>
                      {row}
                    </span>
                  </Tooltip>
                ) : (
                  row
                )}
              </li>
            );
          })}
        </ul>

        {/* The single most important next step. */}
        {data.next_action && (
          <div className="flex items-center justify-between gap-3 rounded-md border border-border bg-muted/40 px-3 py-2.5">
            <span className="text-sm">
              <span className="font-medium">Next step: </span>
              {data.next_action.label}
            </span>
            <Button asChild size="sm" className="shrink-0">
              <Link href={data.next_action.href}>Start</Link>
            </Button>
          </div>
        )}
      </div>
    </SectionCard>
  );
}
