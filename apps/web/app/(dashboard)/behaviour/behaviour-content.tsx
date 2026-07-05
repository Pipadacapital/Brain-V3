'use client';

/**
 * BehaviourContent — Tab #5 "What are people doing on my site?".
 *
 * Consolidation slice (no new analytics): wraps the FOUR existing, battle-tested storefront-behaviour
 * surfaces as URL-synced sub-tabs under one /behaviour route, framed by the shared <TabShell> +
 * permanent "?" ExplainerPanel:
 *   - overview      → BehaviorContent     (sessions/journeys/touches, page-type mix, top viewed products, top searches)
 *   - funnel        → FunnelContent       (sessions → product views → cart adds → purchases)
 *   - abandoned-cart→ AbandonedCartContent(cart sessions converted vs abandoned + recovery rate)
 *   - engagement    → EngagementContent   (engaged multi-touch vs bounce single-touch + avg touches)
 *
 * Each wrapped surface keeps its OWN honest states (skeleton / ErrorCard with request_id / empty-state
 * linking to pixel setup — never a fabricated zero), its DateRangeFilter, and its data_source provenance.
 * These four BFF endpoints expose no generated_at/served_at, so the page-level <FreshnessBadge> honestly
 * renders tone='unknown' rather than fabricating "just now".
 *
 * The sub-tab is driven by `initialTab` (from ?tab=, set by the old-route redirects) and kept in the URL
 * via history.replaceState so a deep-linked section stays shareable without a full navigation.
 */

import * as React from 'react';
import { usePathname } from 'next/navigation';
import { TabShell } from '@/components/ui/tab-shell';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { BehaviorContent } from '../analytics/behavior/behavior-content';
import { FunnelContent } from '../analytics/funnel/funnel-content';
import { AbandonedCartContent } from '../analytics/abandoned-cart/abandoned-cart-content';
import { EngagementContent } from '../analytics/engagement/engagement-content';

const SUBTABS = [
  { key: 'overview', label: 'Page views & sessions' },
  { key: 'funnel', label: 'Funnel' },
  { key: 'abandoned-cart', label: 'Abandoned cart' },
  { key: 'engagement', label: 'Engagement' },
] as const;

type SubTabKey = (typeof SUBTABS)[number]['key'];

function normalizeTab(tab?: string): SubTabKey {
  // Tolerate the legacy "behavior" alias from the redirect surface.
  if (tab === 'behavior') return 'overview';
  return SUBTABS.some((t) => t.key === tab) ? (tab as SubTabKey) : 'overview';
}

export function BehaviourContent({ initialTab }: { initialTab?: string }) {
  const pathname = usePathname();
  const [tab, setTab] = React.useState<SubTabKey>(() => normalizeTab(initialTab));

  // Keep the deep-link shareable without a router round-trip (no scroll jump / refetch).
  const onTabChange = React.useCallback(
    (next: string) => {
      const value = normalizeTab(next);
      setTab(value);
      if (typeof window !== 'undefined') {
        const url = value === 'overview' ? pathname : `${pathname}?tab=${value}`;
        window.history.replaceState(null, '', url);
      }
    },
    [pathname],
  );

  return (
    <TabShell
      title="Behaviour"
      description="What are people doing on my site?"
      freshness={<FreshnessBadge timestamp={null} />}
      explainer={{
        title: 'Behaviour — What are people doing on my site?',
        description:
          'On-site shopper behaviour in one place. Every metric here is built from Brain Pixel touchpoints in the Silver tier (silver_touchpoint) — read via the metric-engine seam, never raw SQL. With no pixel installed these surfaces honestly show an empty state, never a fabricated zero.',
        sections: [
          {
            heading: 'Sub-sections',
            body: 'Page views & sessions (what shoppers browse, the products they view, what they search) · Funnel (how sessions convert through the checkout stages) · Abandoned cart (carts created but not purchased) · Engagement (how deeply sessions browse).',
          },
        ],
        metrics: [
          {
            name: 'Visits / shoppers / interactions',
            definition: 'Distinct browsing visits, distinct shoppers, and total tracked actions in the window.',
            howComputed: 'Aggregated from silver_touchpoint over the selected date range (useBehaviorOverview).',
          },
          {
            name: 'Conversion funnel',
            definition: 'How many visits reach each step — Visit → Product view → Add to cart → Purchase — with the share that continues at every step and where the biggest drop-off happens.',
            howComputed: 'Touchpoints matched to orders in the Silver tier (useFunnelAnalytics). Percentages are 2dp strings from the engine, never re-divided client-side.',
          },
          {
            name: 'Abandonment & recovery rate',
            definition: 'Of sessions that added to cart, the share that abandoned (no order) versus recovered (stitched to a purchase).',
            howComputed: 'Cart sessions vs converted sessions from silver_touchpoint (useAbandonedCart).',
          },
          {
            name: 'Engagement & bounce rate',
            definition: 'Engaged (multi-touch) versus bounced (single-touch) sessions, plus average touches per session.',
            howComputed: 'Touch counts per session from silver_touchpoint (useEngagement).',
          },
        ],
        refreshCadence:
          'Behaviour marts refresh on the Silver/Gold loop. These endpoints do not stamp a served-at time, so freshness is shown honestly as unknown rather than fabricated. Each surface tags its own provenance (live vs synthetic) via data_source.',
        sources: [
          'Brain Pixel events → Silver (silver_touchpoint)',
          'metric-engine storefront-behavior / funnel / abandoned-cart / engagement seams',
        ],
      }}
    >
      <Tabs value={tab} onValueChange={onTabChange}>
        <TabsList aria-label="Behaviour sub-sections">
          {SUBTABS.map((t) => (
            <TabsTrigger key={t.key} value={t.key}>
              {t.label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <BehaviorContent />
        </TabsContent>
        <TabsContent value="funnel">
          <FunnelContent />
        </TabsContent>
        <TabsContent value="abandoned-cart">
          <AbandonedCartContent />
        </TabsContent>
        <TabsContent value="engagement">
          <EngagementContent />
        </TabsContent>
      </Tabs>
    </TabShell>
  );
}
