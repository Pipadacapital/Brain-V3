'use client';

/**
 * CustomersContent — the identity control-plane BROWSE surface (the discover front-door).
 *
 * Customer 360 only resolves a brain_id you already know; this lists the active brand's customers so
 * an operator can FIND one, then drill in (each row links to Customer 360 with the brain_id prefilled).
 *
 * BFF-only (I-ST01): reads ONLY GET /api/v1/identity/customers. Brand scope is server-side (RLS).
 * PII discipline (I-S02): rows show counts + lifecycle/consent only — no raw PII, not even hashed
 * identifier values. Search is hashed server-side; the box accepts a full email/phone to find a match.
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
} from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader } from '@/components/ui/page-header';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { StatusBadge } from '@/components/ui/status-badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { humanize } from '@/lib/format/humanize';
import { useCustomers } from '@/lib/hooks/use-identity';
import type { CustomerListItem } from '@/lib/api/types';

const PAGE_SIZE = 25;

const LIFECYCLES = ['', 'anonymous', 'active', 'merged', 'split', 'erased'] as const;

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

  const { data, isLoading, isFetching, error, refetch } = useCustomers({
    lifecycle: lifecycle || undefined,
    search: search || undefined,
    limit: PAGE_SIZE,
    offset,
  });

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

  return (
    <div className="space-y-6">
      <PageHeader
        title="Customers"
        description="Browse and find resolved customers for the active brand. Open one to see its full 360 — identifiers, merge history, consent — or to merge, unmerge, or erase. Identifiers are vaulted; search by email or phone resolves them without ever exposing raw PII."
      />

      {/* Filters */}
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
                          href={`/identity/customer-360?brain_id=${encodeURIComponent(c.brain_id)}`}
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
                          href={`/identity/customer-360?brain_id=${encodeURIComponent(c.brain_id)}`}
                          className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                          aria-label={`Open Customer 360 for ${c.brain_id}`}
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
    </div>
  );
}
