'use client';

/**
 * SettingsContent — the consolidated Settings hub (IA tab #9).
 *
 * Answers ONE question: "How is my workspace configured, connected, and governed?"
 *
 * This is the single home for everything operational that used to be scattered
 * across the top nav: data connectors, the Brain pixel, the team, privacy/consent,
 * brands — PLUS the data-foundation surfaces (Data Health, Data Quality), Billing,
 * and Models, which left the top nav to live here as deep sub-routes (so they are
 * reorganised, never lost).
 *
 * It stays a card hub (navigation), but is now a client component so it can:
 *   - carry the permanent "?" ExplainerPanel,
 *   - show an honest, live data-foundation freshness badge (from useDataHealth's
 *     lastIngestAt — never a fabricated "just now"; tone='unknown' when the
 *     endpoint exposes no timestamp),
 *   - degrade to an honest EmptyState if the foundation-health probe fails.
 *
 * REUSE, don't reinvent: Card/CardContent, PageHeader, ExplainerPanel,
 * FreshnessBadge, EmptyState are all existing design-system primitives.
 */

import Link from 'next/link';
import {
  Plug,
  Zap,
  Users,
  ShieldCheck,
  Archive,
  Building2,
  ChevronRight,
  Activity,
  Gauge,
  CreditCard,
  BrainCircuit,
  type LucideIcon,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { ExplainerPanel } from '@/components/ui/explainer-panel';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { EmptyState } from '@/components/ui/empty-state';
import { useDataHealth } from '@/lib/hooks/use-analytics';

interface SettingsItem {
  href: string;
  title: string;
  description: string;
  icon: LucideIcon;
  /** Optional per-card trust row (e.g. a live freshness badge for data-foundation cards). */
  meta?: React.ReactNode;
}

interface SettingsGroup {
  heading: string;
  description: string;
  items: SettingsItem[];
}

export function SettingsContent() {
  // Live data-foundation freshness — the only fetch this hub makes. We surface the
  // last Bronze ingest time on the Data Health card and at the page level, honestly:
  // null/error → FreshnessBadge renders tone='unknown', never a fake timestamp.
  const { data, error } = useDataHealth();
  const lastIngestAt =
    data && data.state === 'has_data' ? data.lastIngestAt : null;

  const groups: SettingsGroup[] = [
    {
      heading: 'Data sources & tracking',
      description: 'Where Brain captures truth from — connect, install, and verify ingestion.',
      items: [
        {
          href: '/settings/connectors',
          title: 'Data Connectors',
          description:
            'Connect Shopify, ad platforms, and payment sources. View connection status, sync health, and import past data.',
          icon: Plug,
        },
        {
          href: '/settings/pixel',
          title: 'Brain Pixel',
          description:
            'Install, configure, and verify the first-party Brain tracking pixel on your storefront.',
          icon: Zap,
        },
      ],
    },
    {
      heading: 'Team & access',
      description: 'Who can see and change this workspace.',
      items: [
        {
          href: '/settings/members',
          title: 'Team Members',
          description: 'Invite teammates and manage their roles.',
          icon: Users,
        },
        {
          href: '/settings/brands',
          title: 'Brands',
          description: 'View all your brands and archive ones you no longer need.',
          icon: Building2,
        },
        {
          href: '/settings/archived-brands',
          title: 'Archived Brands',
          description: 'Review archived brands and restore one to the switcher.',
          icon: Archive,
        },
      ],
    },
    {
      heading: 'Privacy & compliance',
      description: 'How Brain keeps customer data lawful, consented, and contactable.',
      items: [
        {
          href: '/settings/consent',
          title: 'Consent & Compliance',
          description:
            'Consent coverage, how many customers are excluded from marketing, and the 9am–9pm IST send window.',
          icon: ShieldCheck,
        },
      ],
    },
    {
      heading: 'Data foundation',
      description: 'The health and trustworthiness of the data behind every dashboard.',
      items: [
        {
          href: '/data/health',
          title: 'Data Health',
          description:
            'Ingestion volume over time, data freshness, and per-connector sync status.',
          icon: Activity,
          meta: (
            <FreshnessBadge
              timestamp={lastIngestAt}
              prefix="Last ingest"
              className="text-xs"
            />
          ),
        },
        {
          href: '/data/quality',
          title: 'Data Quality',
          description:
            'Data-quality letter grades, freshness status, coverage, and the overall trust level of your numbers.',
          icon: Gauge,
          meta: (
            <FreshnessBadge
              timestamp={null}
              prefix="Refreshed"
              className="text-xs"
            />
          ),
        },
      ],
    },
    {
      heading: 'Billing & models',
      description: 'Usage-based billing and the ML models powering predictions.',
      items: [
        {
          href: '/billing',
          title: 'Billing',
          description:
            'Billing periods, the current bill, and invoices — priced on realized revenue truth.',
          icon: CreditCard,
        },
        {
          href: '/ml',
          title: 'Models',
          description:
            'The prediction models behind churn and lifetime-value scores, and which one is live.',
          icon: BrainCircuit,
        },
      ],
    },
  ];

  const explainer = (
    <ExplainerPanel
      title="Settings — how your workspace is configured & governed"
      description="One home for connections, your team, privacy, and the data foundation behind every dashboard."
      sections={[
        {
          heading: 'What lives here',
          body: 'Everything operational: the data sources Brain ingests from, the tracking pixel, your team and brands, privacy & consent governance, the data-foundation health/quality surfaces, billing, and the ML model registry. These were consolidated out of the top nav so the eight goal-tabs stay focused on business questions.',
        },
        {
          heading: 'Data foundation comes first',
          body: 'Data Health and Data Quality tell you whether the numbers in the other tabs can be trusted. If ingestion is stale or DQ grades are low, treat downstream dashboards as estimated, not final.',
        },
      ]}
      metrics={[
        {
          name: 'Last ingest',
          definition: 'When the most recent event from your sources arrived in Brain.',
          howComputed:
            'The timestamp of the newest event received. Older than an hour is marked stale; missing is shown honestly as unknown.',
        },
        {
          name: 'Sync status',
          definition: 'Whether each connector is actively syncing and when it last completed.',
          howComputed: 'Per-connector sync state and last-sync time, read live.',
        },
        {
          name: 'DQ grade & trust gate',
          definition:
            'Letter grades (A+→D) for how fresh, complete, valid, and consistent your data is, plus an overall trust level.',
          howComputed: 'Calculated automatically from checks that run over your data on every refresh.',
        },
      ]}
      refreshCadence="Connection status and ingestion freshness are live (checked about every minute). Data-quality grades refresh roughly every 15 minutes. Billing reflects the latest closed period."
      sources={[
        'Your connected sources (sync state)',
        'Incoming event feed',
        'Automatic data-quality checks',
        'Billing periods / invoices',
        'Prediction model registry',
      ]}
    />
  );

  return (
    <div className="space-y-8">
      <PageHeader
        title="Settings"
        description="Connections, tracking, your team, privacy, and the data foundation behind every dashboard."
        actions={explainer}
        meta={
          <FreshnessBadge
            timestamp={lastIngestAt}
            prefix="Data foundation · last ingest"
          />
        }
      />

      {error ? (
        // Honest degradation: the hub still navigates, but we don't pretend the
        // foundation is fresh when we couldn't read it.
        <EmptyState
          compact
          title="Couldn't read data-foundation health right now"
          description="Connections and settings below still work — only the live freshness badge is unavailable. Open Data Health for details."
          icon={<Activity aria-hidden="true" />}
          action={
            <Link
              href="/data/health"
              className="text-sm font-medium text-primary hover:underline"
            >
              Open Data Health
            </Link>
          }
        />
      ) : null}

      {groups.map((group) => (
        <section key={group.heading} className="space-y-3">
          <div className="space-y-0.5">
            <h2 className="text-sm font-semibold tracking-tight text-foreground">
              {group.heading}
            </h2>
            <p className="text-sm text-muted-foreground">{group.description}</p>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {group.items.map(({ href, title, description, icon: Icon, meta }) => (
              <Link
                key={href}
                href={href}
                className="group rounded-lg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Card className="h-full transition-colors hover:border-primary/50">
                  <CardContent className="flex h-full items-start gap-3 p-5">
                    <span className="flex size-9 flex-shrink-0 items-center justify-center rounded-md border border-border bg-muted/60 text-muted-foreground transition-colors group-hover:border-primary/40 group-hover:text-primary">
                      <Icon className="size-4" aria-hidden="true" />
                    </span>
                    <div className="flex min-w-0 flex-1 flex-col gap-1">
                      <div className="flex items-center justify-between gap-2">
                        <h3 className="text-base font-semibold tracking-tight text-foreground">
                          {title}
                        </h3>
                        <ChevronRight
                          className="size-4 flex-shrink-0 text-muted-foreground/60 transition-transform group-hover:translate-x-0.5 group-hover:text-primary"
                          aria-hidden="true"
                        />
                      </div>
                      <p className="text-sm text-muted-foreground">{description}</p>
                      {meta && <div className="pt-1">{meta}</div>}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}
