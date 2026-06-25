'use client';

/**
 * EventExplorer — recent PIXEL events feed, so a non-technical stakeholder can watch data arrive
 * through their pixel: event type, time, ANONYMIZED ids, and the event's PII-safe details.
 *
 * PIXEL-ONLY: the BFF returns ONLY events received through the pixel (browser events via /collect).
 * Server-trusted connector events (orders, spend, logistics, settlements) are NEVER shown here.
 *
 * PII: the BFF returns only type/time + anonymized ids (brain_anon_id / hashed_session_id) and a
 * PII-redacted `details` map. This component truncates ids further and NEVER renders a raw identifier.
 *
 * A11y: list with role="list"; event types distinguished by icon + text label, never colour alone;
 * consent shown as a labelled StatusBadge; details as a labelled definition list; honest states.
 */

import * as React from 'react';
import {
  Eye, Package, LayoutGrid, Search, PackagePlus, PackageMinus, ShoppingCart, CreditCard,
  ListChecks, Truck, CheckCircle2, XCircle, Ticket, FileText, ShoppingBag, MousePointerClick,
  MousePointer, MoveVertical, LogIn, UserPlus, Fingerprint, Activity, RefreshCw,
} from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import { useRecentEvents } from '@/lib/hooks/use-tracking-health';
import { formatRelativeTime } from '@/components/analytics/data-health-relative-time';
import type { AnalyticsRecentEventRow } from '@/lib/api/types';

/** Pixel-event taxonomy → human label + icon (mirrors packages/pixel-sdk + the universal capture script). */
const EVENT_CONFIG: Record<string, { label: string; icon: React.ElementType }> = {
  'page.viewed': { label: 'Page viewed', icon: Eye },
  'product.viewed': { label: 'Product viewed', icon: Package },
  'collection.viewed': { label: 'Collection viewed', icon: LayoutGrid },
  'search.submitted': { label: 'Search', icon: Search },
  'cart.item_added': { label: 'Item added to cart', icon: PackagePlus },
  'cart.item_removed': { label: 'Item removed from cart', icon: PackageMinus },
  'cart.updated': { label: 'Cart updated', icon: ShoppingCart },
  'cart.viewed': { label: 'Cart viewed', icon: ShoppingCart },
  'checkout.started': { label: 'Checkout started', icon: CreditCard },
  'checkout.step_viewed': { label: 'Checkout step', icon: ListChecks },
  'checkout.shipping_selected': { label: 'Shipping selected', icon: Truck },
  'payment.initiated': { label: 'Payment initiated', icon: CreditCard },
  'payment.succeeded': { label: 'Payment succeeded', icon: CheckCircle2 },
  'payment.failed': { label: 'Payment failed', icon: XCircle },
  'coupon.applied': { label: 'Coupon applied', icon: Ticket },
  'form.submitted': { label: 'Form submitted', icon: FileText },
  'order.placed': { label: 'Order placed', icon: ShoppingBag },
  'rage.click': { label: 'Rage click', icon: MousePointerClick },
  'dead.click': { label: 'Dead click', icon: MousePointer },
  'element.clicked': { label: 'Element clicked', icon: MousePointer },
  'scroll.depth': { label: 'Scroll depth', icon: MoveVertical },
  'user.logged_in': { label: 'Logged in', icon: LogIn },
  'user.signed_up': { label: 'Signed up', icon: UserPlus },
  'identify': { label: 'Identified', icon: Fingerprint },
};

function configFor(eventType: string) {
  return EVENT_CONFIG[eventType] ?? { label: eventType, icon: Activity };
}

/** Truncate an anonymized id for display (not PII, but keep it compact). */
function shortId(id: string | null): string {
  if (!id) return '—';
  return id.length > 10 ? `${id.slice(0, 8)}…` : id;
}

/** 'product_id' → 'product id' for a readable detail label. */
function humanizeKey(key: string): string {
  return key.replace(/_/g, ' ');
}

function EventRow({ row }: { row: AnalyticsRecentEventRow }) {
  const cfg = configFor(row.event_type);
  const Icon = cfg.icon;
  const relTime = formatRelativeTime(row.occurred_at);
  const anon = shortId(row.anon_id);
  const consentLabel = row.has_consent ? 'consent' : 'no consent';
  const detailEntries = Object.entries(row.details ?? {});

  return (
    <li
      className="flex items-start gap-3 py-3"
      aria-label={`${cfg.label} — ${relTime}, anonymous id ${anon}, ${consentLabel}`}
    >
      <span
        className="flex size-8 shrink-0 items-center justify-center rounded-full bg-muted text-muted-foreground"
        aria-hidden="true"
      >
        <Icon className="size-4" />
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline justify-between gap-2">
          <p className="truncate text-sm font-medium text-foreground">{cfg.label}</p>
          <time className="shrink-0 text-xs tabular-nums text-muted-foreground" dateTime={row.occurred_at}>
            {relTime}
          </time>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <span className="truncate font-mono text-xs text-muted-foreground">{row.event_type}</span>
          <span className="truncate font-mono text-xs text-muted-foreground">anon: {anon}</span>
          <StatusBadge tone={row.has_consent ? 'success' : 'neutral'} hideDot={!row.has_consent}>
            {consentLabel}
          </StatusBadge>
        </div>
        {detailEntries.length > 0 && (
          <dl
            className="mt-2 flex flex-wrap gap-x-4 gap-y-1 rounded-md bg-muted/50 px-2.5 py-1.5"
            aria-label={`${cfg.label} details`}
          >
            {detailEntries.map(([key, value]) => (
              <div key={key} className="flex min-w-0 items-baseline gap-1.5">
                <dt className="shrink-0 text-xs capitalize text-muted-foreground">{humanizeKey(key)}</dt>
                <dd className="min-w-0 truncate font-mono text-xs text-foreground" title={value}>
                  {value}
                </dd>
              </div>
            ))}
          </dl>
        )}
      </div>
    </li>
  );
}

export function EventExplorer() {
  const { data, isLoading, error, refetch, isFetching } = useRecentEvents(20);

  return (
    <SectionCard
      title={
        <span className="flex items-center gap-2">
          <Activity className="size-4 text-muted-foreground" aria-hidden="true" />
          Pixel events
          {isFetching && (
            <RefreshCw className="size-3.5 animate-spin text-muted-foreground" aria-hidden="true" />
          )}
        </span>
      }
      description="Events received through your pixel (type, time, anonymized ids, and event details). Updates live. Connector data (orders, spend) is not shown here. No raw personal data is shown."
      data-testid="event-explorer"
    >
      {isLoading ? (
        <div className="space-y-3" aria-busy="true" aria-label="Pixel events — loading">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="flex items-center gap-3">
              <Skeleton className="size-8 shrink-0 rounded-full" />
              <div className="flex-1 space-y-1.5">
                <Skeleton className="h-3 w-2/3" />
                <Skeleton className="h-3 w-1/3" />
              </div>
            </div>
          ))}
        </div>
      ) : error ? (
        <ErrorCard error={error} retry={refetch} />
      ) : (data?.rows.length ?? 0) === 0 ? (
        <EmptyState
          title="No pixel events yet"
          description="Events will appear here as visitors browse your site with the pixel installed."
          icon={<Activity />}
          compact
        />
      ) : (
        <ul role="list" aria-label="Recent pixel events" className="divide-y divide-border">
          {data!.rows.map((row) => (
            <EventRow key={row.event_id} row={row} />
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
