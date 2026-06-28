'use client';

/**
 * CustomersContent — Tab #2 "Who are my customers?".
 *
 * Re-homes the identity control-plane BROWSE surface (was app/(dashboard)/identity/customers)
 * under the new top-level /customers route. Each row now links to /customers/{brain_id}
 * (the new Customer Profile detail) instead of the old /identity/customer-360 lookup.
 *
 * BFF-only (I-ST01): reads ONLY GET /api/v1/identity/customers via useCustomers. Brand scope is
 * server-side (RLS). PII discipline (I-S02): rows show counts + lifecycle/consent only — no raw
 * PII, not even hashed identifier values. Search is hashed server-side; the box accepts a full
 * email/phone to find a match.
 *
 * GENUINE GAP (flagged, never faked): the list endpoint filters only by IDENTITY lifecycle
 * (anonymous|active|merged|split|erased) and each row carries NO business-segment / LTV /
 * order_count / confidence field. So the requested RFM segment chips (VIP / Loyal / At-Risk /
 * Churned / One-time / Window-shoppers) and the LTV/segment/confidence columns cannot be
 * populated without a BFF change (segment field + ?segment= param sourced from
 * gold_customer_scores). The chips are rendered as a disabled PREVIEW with an honest explainer;
 * the working filter remains identity lifecycle. See the openItems in the slice summary.
 *
 * A11y: labelled search + filter controls; the result region is aria-live; lifecycle is text+icon.
 */

import * as React from 'react';
import Link from 'next/link';
import {
  Users,
  Search,
  ShieldCheck,
  ShieldOff,
  ChevronLeft,
  ChevronRight,
  ArrowRight,
  CircleSlash,
  Lock,
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { SectionCard } from '@/components/ui/section-card';
import { MetricCard } from '@/components/ui/metric-card';
import { TabShell } from '@/components/ui/tab-shell';
import { FreshnessBadge } from '@/components/ui/freshness-badge';
import { humanize } from '@/lib/format/humanize';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import { useCustomers } from '@/lib/hooks/use-identity';
import { useExecutiveMetrics } from '@/lib/hooks/use-analytics';
import type { CustomerListItem } from '@/lib/api/types';
import type { CurrencyCode } from '@brain/money';

const PAGE_SIZE = 25;

const LIFECYCLES = ['', 'anonymous', 'active', 'merged', 'split', 'erased'] as const;

/** The business (RFM) segments the IA targets — pending a BFF row field (gold_customer_scores). */
const BUSINESS_SEGMENTS = [
  'VIP',
  'Loyal',
  'At-Risk',
  'Churned',
  'One-time',
  'Window-shoppers',
] as const;

function LifecycleBadge({ state }: { state: string }) {
  const tone =
    state === 'active'
      ? 'success'
      : state === 'erased'
        ? 'destructive'
        : state === 'merged' || state === 'split'
          ? 'warning'
          : 'neutral';
  return (
    <StatusBadge tone={tone} hideDot>
      {humanize(state)}
    </StatusBadge>
  );
}

function ConsentDot({ on, label }: { on: boolean; label: string }) {
  return on ? (
    <ShieldCheck className="h-4 w-4 text-success" aria-label={`${label}: granted`} />
  ) : (
    <ShieldOff className="h-4 w-4 text-muted-foreground" aria-label={`${label}: not granted`} />
  );
}

export function CustomersContent() {
  const [searchInput, setSearchInput] = React.useState('');
  const [search, setSearch] = React.useState('');
  const [lifecycle, setLifecycle] = React.useState('');
  const [offset, setOffset] = React.useState(0);

  const { data, isLoading, isFetching, error, refetch, dataUpdatedAt } = useCustomers({
    lifecycle: lifecycle || undefined,
    search: search || undefined,
    limit: PAGE_SIZE,
    offset,
  });

  // Headline KPIs (Who are my customers?) — repeat rate + avg LTV from the Gold executive marts.
  const exec = useExecutiveMetrics();
  const execRow =
    exec.data?.state === 'has_data' ? exec.data.metrics[0] : undefined;

  function onSearch(e: React.FormEvent) {
    e.preventDefault();
    setOffset(0);
    setSearch(searchInput.trim());
  }

  function onLifecycle(next: string) {
    setOffset(0);
    setLifecycle(next);
  }

  const items = data?.items ?? [];
  const total = data?.total ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + PAGE_SIZE, total);
  const canPrev = offset > 0;
  const canNext = offset + PAGE_SIZE < total;

  // The list endpoint exposes no generated_at — but the react-query fetch time is an honest
  // "read live at" for a control-plane read (no Gold-mart cadence to report).
  const listFetchedIso = dataUpdatedAt ? new Date(dataUpdatedAt).toISOString() : null;

  return (
    <TabShell
      title="Customers"
      description="Who are my customers?"
      freshness={<FreshnessBadge timestamp={listFetchedIso} prefix="Read" />}
      explainer={{
        title: 'Customers — Who are my customers?',
        description:
          'Every resolved customer profile for the active brand, searchable and filterable. Click a row to open the full Customer Profile (360).',
        metrics: [
          {
            name: 'Customer (Brain ID)',
            definition:
              "A resolved identity — all of a person's sessions, orders and contacts stitched into one durable brain_id.",
            howComputed: 'Identity resolution over the Silver journey/identity spine (BFF /v1/identity/customers).',
          },
          {
            name: 'Lifecycle',
            definition: 'Identity lifecycle state: anonymous, active, merged, split or erased.',
            howComputed: 'Identity control-plane; filterable via the list endpoint.',
          },
          {
            name: 'Identifiers',
            definition: 'How many active identifiers (email/phone/anon) link to this customer. Counts only — never raw PII.',
            howComputed: 'Count of active links in the identity graph.',
          },
          {
            name: 'Repeat-purchase rate / Avg LTV',
            definition: 'Headline customer-base health: share of customers with >1 order, and average lifetime value.',
            howComputed: 'Gold executive marts (analyticsApi.getExecutiveMetrics); honest-null when the denominator is 0.',
          },
        ],
        sections: [
          {
            heading: 'Business segments (preview)',
            body: 'VIP / Loyal / At-Risk / Churned / One-time / Window-shoppers are RFM-based. The list endpoint today carries only identity lifecycle on each row — not an RFM segment, LTV or order count. So the segment chips are shown DISABLED until the BFF surfaces a per-row segment field (+ ?segment= param) from gold_customer_scores. We never fake a segment. Per-customer RFM/churn IS available today on a customer’s profile — open any customer and see the Segments tab.',
          },
          {
            heading: 'Privacy',
            body: 'Brand-scoped (RLS). Counts + lifecycle/consent only — raw email/phone never leave the vault. Search hashes the term server-side.',
          },
        ],
        refreshCadence: 'The customer list is read live from the BFF on each query (no mart cadence). Headline LTV/repeat-rate refresh on the Gold loop.',
        sources: ['BFF /v1/identity/customers', 'Gold executive marts (headline KPIs)', 'gold_customer_scores (segments — pending)'],
      }}
    >
      {/* Headline — only when the Gold marts have data (no fake zeros). */}
      {execRow ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          <MetricCard
            label="Customers (this view)"
            value={total.toLocaleString()}
            unit={search ? 'search results' : 'resolved'}
            freshness={<FreshnessBadge timestamp={listFetchedIso} prefix="Read" />}
          />
          <MetricCard
            label="Repeat-purchase rate"
            value={execRow.repeat_rate_pct != null ? `${execRow.repeat_rate_pct}%` : '—'}
            unit="customers with >1 order"
          />
          <MetricCard
            label="Avg lifetime value"
            value={
              execRow.ltv_minor != null
                ? formatMoneyDisplay(execRow.ltv_minor, execRow.currency_code as CurrencyCode)
                : '—'
            }
            unit="per customer"
          />
        </div>
      ) : null}

      {/* Business-segment chips — disabled PREVIEW (genuine BFF gap; never faked). */}
      <SectionCard
        title="Segments"
        description="Filter by business segment — unlocks when RFM scores are surfaced on the customer list."
      >
        <div className="flex flex-wrap items-center gap-2">
          {BUSINESS_SEGMENTS.map((seg) => (
            <Button
              key={seg}
              type="button"
              variant="outline"
              size="sm"
              disabled
              title="Business segments require a per-row RFM field from gold_customer_scores (coming soon). Open a customer to see their RFM/churn segment today."
              aria-disabled="true"
            >
              <Lock className="mr-1.5 h-3 w-3" aria-hidden="true" />
              {seg}
            </Button>
          ))}
          <span className="ml-1 text-xs text-muted-foreground">
            RFM segments are available per-customer today (open any profile → Segments). List-wide
            filtering is pending a BFF field — see the “?” panel.
          </span>
        </div>
      </SectionCard>

      {/* Working filters: search + identity lifecycle. */}
      <div className="flex flex-wrap items-end gap-3">
        <form onSubmit={onSearch} className="flex flex-1 items-end gap-2" role="search">
          <div className="min-w-[14rem] flex-1 max-w-md">
            <label htmlFor="customer-search" className="mb-1.5 block text-sm font-medium">
              Search by email or phone
            </label>
            <Input
              id="customer-search"
              name="search"
              placeholder="e.g. priya@example.com or 9876543210"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              autoComplete="off"
              spellCheck={false}
            />
          </div>
          <Button type="submit">
            <Search className="mr-2 h-4 w-4" aria-hidden="true" />
            Search
          </Button>
          {search.length > 0 ? (
            <Button
              type="button"
              variant="ghost"
              onClick={() => {
                setSearchInput('');
                setSearch('');
                setOffset(0);
              }}
            >
              Clear
            </Button>
          ) : null}
        </form>

        <div>
          <label htmlFor="lifecycle-filter" className="mb-1.5 block text-sm font-medium">
            Lifecycle
          </label>
          <select
            id="lifecycle-filter"
            value={lifecycle}
            onChange={(e) => onLifecycle(e.target.value)}
            className="h-9 rounded-md border border-input bg-background px-3 text-sm"
          >
            {LIFECYCLES.map((l) => (
              <option key={l || 'any'} value={l}>
                {l === '' ? 'Any' : humanize(l)}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div aria-live="polite" aria-busy={isLoading || isFetching}>
        {isLoading ? (
          <div className="space-y-2" aria-hidden="true">
            {Array.from({ length: 6 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
        ) : error ? (
          <ErrorCard error={error} retry={refetch} />
        ) : items.length === 0 ? (
          <EmptyState
            icon={<CircleSlash className="h-6 w-6" aria-hidden="true" />}
            title={search ? 'No matching customer' : 'No customers yet'}
            description={
              search
                ? `No customer for this brand matches "${search}".`
                : 'As identity resolution runs on your incoming orders and events, resolved customers appear here.'
            }
          />
        ) : (
          <Card>
            <CardContent className="p-0">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b text-left text-muted-foreground">
                    <th scope="col" className="px-4 py-2.5 font-medium">Brain ID</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Lifecycle</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Identifiers</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">Consent</th>
                    <th scope="col" className="px-4 py-2.5 font-medium">First seen</th>
                    <th scope="col" className="px-4 py-2.5 font-medium sr-only">Open</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map((c: CustomerListItem) => (
                    <tr key={c.brain_id} className="border-b last:border-0 hover:bg-muted/40">
                      <td className="px-4 py-2.5">
                        <Link
                          href={`/customers/${encodeURIComponent(c.brain_id)}`}
                          className="font-mono text-xs hover:underline"
                        >
                          {c.brain_id}
                        </Link>
                        {c.merged_into ? (
                          <span className="ml-2 text-[10px] text-warning">→ merged</span>
                        ) : null}
                      </td>
                      <td className="px-4 py-2.5">
                        <LifecycleBadge state={c.lifecycle_state} />
                      </td>
                      <td className="px-4 py-2.5 tabular-nums">{c.identifier_count}</td>
                      <td className="px-4 py-2.5">
                        <span className="inline-flex items-center gap-2">
                          <ConsentDot on={c.resolution_consent} label="Identity resolution" />
                          <ConsentDot on={c.ai_processing_consent} label="AI processing" />
                        </span>
                      </td>
                      <td className="px-4 py-2.5 text-muted-foreground">
                        {new Date(c.created_at).toLocaleDateString()}
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <Link
                          href={`/customers/${encodeURIComponent(c.brain_id)}`}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          aria-label={`Open the profile for ${c.brain_id}`}
                        >
                          Open <ArrowRight className="h-3 w-3" aria-hidden="true" />
                        </Link>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        )}

        {/* Pagination */}
        {!isLoading && !error && total > 0 ? (
          <div className="mt-4 flex items-center justify-between text-sm text-muted-foreground">
            <span>
              Showing <strong className="text-foreground">{from}</strong>–
              <strong className="text-foreground">{to}</strong> of{' '}
              <strong className="text-foreground">{total}</strong>
              {search ? ' (search results)' : ''}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                disabled={!canPrev || isFetching}
                onClick={() => setOffset(Math.max(offset - PAGE_SIZE, 0))}
              >
                <ChevronLeft className="mr-1 h-4 w-4" aria-hidden="true" /> Prev
              </Button>
              <Button
                variant="outline"
                size="sm"
                disabled={!canNext || isFetching}
                onClick={() => setOffset(offset + PAGE_SIZE)}
              >
                Next <ChevronRight className="ml-1 h-4 w-4" aria-hidden="true" />
              </Button>
            </div>
          </div>
        ) : null}
      </div>

      <p className="flex items-center gap-2 text-xs text-muted-foreground">
        <Users className="h-3.5 w-3.5" aria-hidden="true" />
        Brand-scoped (RLS). Counts only — raw email/phone never leave the vault.
      </p>
    </TabShell>
  );
}
