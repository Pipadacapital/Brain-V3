'use client';

/**
 * MarketingContent — Tab #4 "Which campaigns/channels work?".
 *
 * IA-redesign tab that folds the three former, scattered marketing surfaces into ONE
 * goal-oriented tab with sub-sections (no new analytics — pure reorganization + explainer
 * + honest empty states + freshness):
 *   - Attribution  → reuses analytics/attribution/attribution-content.tsx
 *                    (AttributionModelSelector + AttributedChannelChart + ChannelRoasTable
 *                     + ReconciliationResidualCard — model-switchable channel credit & ROAS).
 *   - Spend        → reuses analytics/spend/spend-content.tsx
 *                    (blended ROAS + per-platform spend + spend-over-time + ROAS detail).
 *   - Conversion feedback → reuses analytics/conversion-feedback/conversion-feedback-content.tsx
 *                    (Meta CAPI passback summary / events / deletions).
 *
 * Sub-tab routing is URL-driven via the page's `?tab=` query (initialTab), so the old
 * redirects (/analytics/spend → /marketing?tab=spend,
 * /analytics/conversion-feedback → /marketing?tab=conversion-feedback) deep-link correctly.
 *
 * Each reused content component keeps its OWN honest empty states, ErrorCards, and money
 * formatting. The Marketing shell adds: the permanent "?" ExplainerPanel (explaining every
 * attribution model + ROAS + CAPI), and a per-section FreshnessBadge. The marketing BFF
 * endpoints don't expose a served-at timestamp today, so freshness honestly renders
 * tone='unknown' (never a fabricated "just now"); the explainer states the refresh cadence.
 *
 * Granularity: attribution credit + ROAS are shown BOTH channel-level (AttributedChannelChart +
 * ChannelRoasTable) AND per-CAMPAIGN (#32c — the CampaignAttributionTable in AttributionContent reads
 * gold_campaign_attribution under the same model selector). Honest n/a ROAS when a campaign has no
 * spend; per-currency money, never blended; we do not fabricate campaign rows.
 */

import { useState } from 'react';
import { Megaphone, Target, BarChart3, Send } from 'lucide-react';
import { TabShell } from '@/components/ui/tab-shell';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { AttributionContent } from '../analytics/attribution/attribution-content';
import { SpendContent } from '../analytics/spend/spend-content';
import { ConversionFeedbackContent } from '../analytics/conversion-feedback/conversion-feedback-content';

type MarketingTab = 'attribution' | 'spend' | 'conversion-feedback';

const TABS: { value: MarketingTab; label: string; icon: typeof Target }[] = [
  { value: 'attribution', label: 'Attribution', icon: Target },
  { value: 'spend', label: 'Spend & ROAS', icon: BarChart3 },
  { value: 'conversion-feedback', label: 'Conversion feedback', icon: Send },
];

/** Map the raw ?tab= value to a known sub-tab; default to attribution. */
function normalizeTab(raw: string | undefined): MarketingTab {
  if (raw === 'spend' || raw === 'conversion-feedback') return raw;
  return 'attribution';
}

/** A thin freshness row above each reused surface (honest 'unknown' — no served-at exposed). */
function SectionFreshness({ label }: { label: string }) {
  return (
    <div className="flex items-center justify-end">
      <FreshnessBadge timestamp={null} prefix={`${label} ·`} />
    </div>
  );
}

export function MarketingContent({ initialTab }: { initialTab?: string }) {
  const [tab, setTab] = useState<MarketingTab>(() => normalizeTab(initialTab));

  return (
    <TabShell
      title="Marketing"
      description="Which campaigns and channels actually work?"
      eyebrow={
        <span className="inline-flex items-center gap-1.5">
          <Megaphone className="size-3.5" aria-hidden="true" />
          Marketing
        </span>
      }
      explainer={{
        title: 'Marketing — Which campaigns/channels work?',
        description:
          'Attribution by channel under the model you choose, ad spend and ROAS, and conversion-feedback (CAPI) delivery — in one place.',
        sections: [
          {
            heading: 'Attribution models',
            body: (
              <ul className="list-inside list-disc space-y-1">
                <li>
                  <span className="font-medium text-foreground">First-touch</span> — all credit to
                  the first channel a customer touched.
                </li>
                <li>
                  <span className="font-medium text-foreground">Last-touch</span> — all credit to the
                  last channel before the purchase.
                </li>
                <li>
                  <span className="font-medium text-foreground">Linear</span> — credit split evenly
                  across every touch in the journey.
                </li>
                <li>
                  <span className="font-medium text-foreground">Position-based</span> — weights the
                  first and last touches more heavily than the middle.
                </li>
                <li>
                  <span className="font-medium text-foreground">Data-driven</span> — learns each
                  channel&apos;s real influence from your own customer journeys, by measuring how
                  much revenue would be lost without it.
                </li>
                <li>
                  Switch models with the selector — totals always add back up to your confirmed
                  revenue (attributed + unattributed = confirmed; the leftover is shown, never
                  hidden).
                </li>
              </ul>
            ),
          },
          {
            heading: 'How to read this tab',
            body:
              'Attribution answers which channels earned the revenue. Spend & ROAS shows what you paid and the return. Conversion feedback proves which purchases were shared back with Meta (only ever with customer consent).',
          },
          {
            heading: 'Granularity',
            body:
              'Attribution and ROAS are shown both channel-level and per-campaign (attributed revenue, spend, orders and ROAS for each campaign under the selected model). ROAS shows a dash when a campaign has no spend; nothing is made up.',
          },
        ],
        metrics: [
          {
            name: 'Attributed revenue',
            definition: 'Revenue credited to each channel under the selected attribution model.',
            howComputed:
              'Calculated from your customers’ actual journeys — the same journeys always give the same answer, under whichever model you pick.',
          },
          {
            name: 'Reconciliation residual',
            definition: 'Attributed + unattributed always equals your confirmed revenue.',
            howComputed:
              'Confirmed revenue − attributed = unattributed; the leftover is always shown, never hidden.',
          },
          {
            name: 'Channel ROAS',
            definition: 'Return on ad spend per channel, and blended.',
            howComputed:
              'Attributed (or confirmed) revenue ÷ ad spend, within the same currency only; shows a dash when spend is zero.',
          },
          {
            name: 'Ad spend',
            definition: 'Spend pulled from connected ad platforms for the active ad account.',
            howComputed: 'Synced daily from your Meta and Google ad accounts.',
          },
          {
            name: 'Conversion feedback',
            definition: 'Confirmed purchases passed back to Meta, plus blocks and deletions.',
            howComputed:
              'From Brain’s record of every share decision — a purchase is only ever shared with the customer’s advertising consent, which is off by default.',
          },
        ],
        refreshCadence:
          'Attribution and ad-spend figures refresh on the regular analytics cycle; conversion feedback is read live.',
        sources: [
          'Your customer journeys and orders',
          'Meta and Google ad accounts',
          'Confirmed revenue records',
          'Meta conversion-sharing log',
        ],
      }}
    >
      <Tabs value={tab} onValueChange={(v) => setTab(v as MarketingTab)}>
        <TabsList aria-label="Marketing sections">
          {TABS.map(({ value, label, icon: Icon }) => (
            <TabsTrigger key={value} value={value}>
              <Icon className="size-3.5" aria-hidden="true" />
              {label}
            </TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="attribution" className="space-y-3">
          <SectionFreshness label="Attribution & channel ROAS" />
          <AttributionContent />
        </TabsContent>

        <TabsContent value="spend" className="space-y-3">
          <SectionFreshness label="Ad spend & ROAS" />
          <SpendContent />
        </TabsContent>

        <TabsContent value="conversion-feedback" className="space-y-3">
          <SectionFreshness label="Conversion feedback" />
          <ConversionFeedbackContent />
        </TabsContent>
      </Tabs>
    </TabShell>
  );
}
