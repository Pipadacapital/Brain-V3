'use client';

/**
 * TouchpointTimeline — the ordered touchpoint timeline for a SELECTED order
 * (Silver-tier journey). Resolves an order → its deterministically-stitched anon
 * journey → the ordered touches (touch_seq asc) from silver.touchpoint via the
 * metric-engine journey seam (I-ST01 — the UI never queries StarRocks).
 *
 * It is a read PROJECTION (no aggregation, no money) — one ordered list item per touch,
 * with channel (icon + text — never colour-only), timestamp, UTM/referrer context, and
 * first/last-touch flags. An order with no stitched journey shows an honest empty state
 * (never a fabricated touch).
 *
 * A11y:
 *   - the timeline is an ordered list (<ol>) — reading order matches visual order.
 *   - each channel is an icon + text label (never colour-only).
 *   - first/last-touch are text badges, not colour cues.
 *   - the search input is labelled; the empty state is announced.
 */

import { useState } from 'react';
import {
  Megaphone,
  Facebook,
  Search,
  Music2,
  Mail,
  Share2,
  Link2,
  Globe,
  Flag,
  Footprints,
  Route,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { SyntheticBadge } from '@/components/analytics/synthetic-badge';
import { useJourneyTimeline } from '@/lib/hooks/use-analytics';
import type { JourneyChannel, JourneyTouchpointRow } from '@/lib/api/types';

const CHANNEL_META: Record<
  JourneyChannel,
  { label: string; icon: React.ComponentType<{ className?: string }> }
> = {
  paid: { label: 'Paid', icon: Megaphone },
  paid_meta: { label: 'Paid · Meta', icon: Facebook },
  paid_google: { label: 'Paid · Google', icon: Search },
  paid_tiktok: { label: 'Paid · TikTok', icon: Music2 },
  email: { label: 'Email', icon: Mail },
  organic_social: { label: 'Organic Social', icon: Share2 },
  referral: { label: 'Referral', icon: Link2 },
  direct: { label: 'Direct', icon: Globe },
};

function channelMeta(channel: JourneyChannel) {
  return CHANNEL_META[channel] ?? { label: channel, icon: Globe };
}

/** ISO → a stable, locale-aware short timestamp (no float math; pure display). */
function fmtTime(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function TouchRow({ touch }: { touch: JourneyTouchpointRow }) {
  const meta = channelMeta(touch.channel);
  const Icon = meta.icon;

  const utmBits = [touch.utm_source, touch.utm_medium, touch.utm_campaign]
    .filter((v): v is string => Boolean(v))
    .join(' / ');
  const context = utmBits || touch.referrer_host || touch.landing_path || null;

  return (
    <li
      className="flex items-start gap-3"
      data-testid={`journey-touch-${touch.touch_seq}`}
    >
      {/* Timeline node + connector line. */}
      <div className="flex flex-col items-center">
        <span
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full border border-border bg-muted text-muted-foreground"
          aria-hidden="true"
        >
          <Icon className="h-3.5 w-3.5" />
        </span>
      </div>

      <div className="flex-1 pb-4 -mt-0.5">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{meta.label}</span>
          <span className="text-xs text-muted-foreground">·</span>
          <span className="text-xs text-muted-foreground">{touch.event_type}</span>

          {touch.is_first_touch && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Footprints className="h-2.5 w-2.5" aria-hidden="true" />
              First touch
            </span>
          )}
          {touch.is_last_touch && (
            <span className="inline-flex items-center gap-1 rounded-md border border-border bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <Flag className="h-2.5 w-2.5" aria-hidden="true" />
              Last touch
            </span>
          )}
        </div>
        <p className="text-xs text-muted-foreground tabular-nums">{fmtTime(touch.occurred_at)}</p>
        {context && (
          <p className="text-xs text-muted-foreground/80 truncate" title={context}>
            {context}
          </p>
        )}
      </div>
    </li>
  );
}

export function TouchpointTimeline() {
  const [draft, setDraft] = useState('');
  const [orderId, setOrderId] = useState<string | null>(null);

  const { data, isLoading, error, refetch } = useJourneyTimeline(orderId);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const v = draft.trim();
    setOrderId(v.length > 0 ? v : null);
  };

  const hasData = data?.state === 'has_data';

  return (
    <div className="space-y-3" data-testid="journey-timeline-section">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <div className="flex flex-col gap-1">
          <label htmlFor="journey-order-id" className="text-xs font-medium text-muted-foreground">
            Order ID
          </label>
          <input
            id="journey-order-id"
            type="text"
            inputMode="text"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder="e.g. 4521987654321"
            data-testid="journey-order-input"
            className="h-9 w-64 max-w-full rounded-md border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring"
          />
        </div>
        <Button type="submit" size="sm" variant="outline" data-testid="journey-timeline-submit">
          <Route className="mr-2 h-4 w-4" aria-hidden="true" />
          Trace journey
        </Button>
      </form>

      {orderId === null && (
        <Card data-testid="journey-timeline-prompt">
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <Route className="h-7 w-7 text-muted-foreground" aria-hidden="true" />
            <p className="text-sm text-muted-foreground max-w-md">
              Enter an order ID to trace its journey — the ordered touchpoints leading to that
              order, deterministically stitched from the anonymous session.
            </p>
          </CardContent>
        </Card>
      )}

      {orderId !== null && isLoading && (
        <div className="space-y-2" aria-busy="true" aria-label="Loading journey timeline…">
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
          <Skeleton className="h-12 w-full" />
        </div>
      )}

      {orderId !== null && !isLoading && error && <ErrorCard error={error} retry={refetch} />}

      {orderId !== null && !isLoading && !error && data?.state === 'no_data' && (
        <Card data-testid="journey-timeline-empty">
          <CardContent className="flex flex-col items-center gap-2 py-8 text-center">
            <Unplugged />
            <p className="text-sm font-medium text-foreground">No stitched journey for this order</p>
            <p className="text-sm text-muted-foreground max-w-md">
              We could not deterministically link order <span className="font-mono">{orderId}</span>{' '}
              to an anonymous journey. Stitching reads <span className="font-mono">brain_anon_id</span>{' '}
              back from the order at checkout — it is never inferred.
            </p>
          </CardContent>
        </Card>
      )}

      {orderId !== null && !isLoading && !error && hasData && (
        <Card data-testid="journey-timeline-result">
          <CardContent className="py-5">
            <div className="mb-3 flex flex-wrap items-center gap-2">
              <span className="text-sm font-medium text-foreground">
                Journey for order <span className="font-mono">{data.order_id}</span>
              </span>
              <span className="text-xs text-muted-foreground">
                · {data.touches.length} touchpoint{data.touches.length === 1 ? '' : 's'}
              </span>
              {data.data_source === 'synthetic' && (
                <SyntheticBadge
                  data-testid="journey-timeline-synthetic-badge"
                  reason="This journey is built from clearly-labelled synthetic touchpoint fixtures (real shape, synthetic source) so the timeline is demoable. Real page.viewed coverage is thin in dev."
                />
              )}
            </div>

            {data.touches.length === 0 ? (
              <p className="text-sm text-muted-foreground italic">
                Stitched, but no touchpoints recorded for this journey.
              </p>
            ) : (
              <ol className="ml-1">
                {[...data.touches]
                  .sort((a, b) => a.touch_seq - b.touch_seq)
                  .map((t) => (
                    <TouchRow key={t.touch_seq} touch={t} />
                  ))}
              </ol>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}

/** A tiny inline "no link" glyph (icon-only is decorative; the text carries meaning). */
function Unplugged() {
  return <Link2 className="h-7 w-7 text-muted-foreground" aria-hidden="true" />;
}
