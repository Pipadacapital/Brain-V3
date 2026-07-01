'use client';

/**
 * DataContent — the connector-records browser.
 *
 * Shows the CANONICAL business records each connector produces (Silver serving marts), newest-first,
 * 20 per page, with a date-range filter and free-text search:
 *   • Orders    → mv_silver_order_state   (Shopify / WooCommerce)
 *   • Shipments → mv_silver_shipment       (Shiprocket / GoKwik)
 *   • Ad spend  → mv_silver_marketing_spend (Meta / Google)
 *
 * All reads go through the metric-engine seam via GET /api/v1/analytics/records/:entity (brand-scoped,
 * BRAND_PREDICATE). Column metadata + per-cell format hints come from the server, so the table renders
 * generically. Money is rendered from bigint minor-unit strings via formatMoneyDisplay (I-S07 — no float).
 */

import { useState } from 'react';
import { Package, Truck, Megaphone, Search as SearchIcon } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { PageHeader } from '@/components/ui/page-header';
import { useConnectorRecords } from '@/lib/hooks/use-analytics';
import { formatMoneyDisplay } from '@/lib/format/money-display';
import type { CurrencyCode } from '@brain/money';
import type { AnalyticsRecordColumn, RecordEntity } from '@/lib/api/types';
import { cn } from '@/lib/utils';

const TABS: Array<{ key: RecordEntity; label: string; icon: typeof Package }> = [
  { key: 'orders', label: 'Orders', icon: Package },
  { key: 'shipments', label: 'Shipments', icon: Truck },
  { key: 'ad_spend', label: 'Ad spend', icon: Megaphone },
];

/** Default window: last 90 days (matches the BFF default). */
function isoDaysAgo(days: number): string {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().split('T')[0] as string;
}
function isoToday(): string {
  return new Date().toISOString().split('T')[0] as string;
}

/** Format one cell from its server-declared type. Robust to nulls; money stays bigint-minor-safe. */
function formatCell(value: string | null, col: AnalyticsRecordColumn, row: Record<string, string | null>): string {
  if (value === null || value === '') return '—';
  switch (col.type) {
    case 'money': {
      const ccy = (col.currencyKey ? row[col.currencyKey] : null) ?? 'INR';
      try {
        return formatMoneyDisplay(value, ccy as CurrencyCode);
      } catch {
        return value;
      }
    }
    case 'number':
      return Number.isFinite(Number(value)) ? Number(value).toLocaleString() : value;
    case 'date':
      // Values look like '2026-07-01 09:47:29.000 UTC' or '2026-07-01' — trim to minute for readability
      // (no Date() parse, which is brittle across the ' UTC' suffix).
      return value.replace(' UTC', '').replace('T', ' ').slice(0, 16);
    default:
      return value;
  }
}

export function DataContent() {
  const [entity, setEntity] = useState<RecordEntity>('orders');
  const [from, setFrom] = useState<string>(isoDaysAgo(90));
  const [to, setTo] = useState<string>(isoToday());
  const [searchInput, setSearchInput] = useState<string>('');
  const [search, setSearch] = useState<string>(''); // applied (on submit)
  const [page, setPage] = useState<number>(1);

  const { data, isLoading, isFetching, error } = useConnectorRecords(entity, { from, to, search, page });

  const total = data?.total ?? 0;
  const limit = data?.limit ?? 20;
  const columns = data?.columns ?? [];
  const rows = data?.rows ?? [];
  const totalPages = Math.max(1, Math.ceil(total / limit));
  const startRow = total === 0 ? 0 : (page - 1) * limit + 1;
  const endRow = Math.min(page * limit, total);

  function switchTab(next: RecordEntity) {
    setEntity(next);
    setPage(1);
    setSearch('');
    setSearchInput('');
  }
  function applySearch() {
    setSearch(searchInput.trim());
    setPage(1);
  }
  function onFilterChange(setter: (v: string) => void, v: string) {
    setter(v);
    setPage(1);
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Data"
        description="Browse the canonical records flowing in from your connectors — orders, shipments, and ad spend. Newest first."
      />

      {/* Tabs */}
      <div className="flex flex-wrap gap-2" role="tablist" aria-label="Record type">
        {TABS.map((t) => {
          const active = entity === t.key;
          return (
            <button
              key={t.key}
              role="tab"
              aria-selected={active}
              onClick={() => switchTab(t.key)}
              className={cn(
                'inline-flex items-center gap-2 rounded-md border px-3 py-1.5 text-sm font-medium transition-colors',
                active
                  ? 'border-primary bg-primary/10 text-primary'
                  : 'border-border text-muted-foreground hover:bg-muted',
              )}
            >
              <t.icon className="h-4 w-4" aria-hidden="true" />
              {t.label}
            </button>
          );
        })}
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-end gap-3">
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          From
          <Input type="date" value={from} max={to} onChange={(e) => onFilterChange(setFrom, e.target.value)} className="h-9 w-[9.5rem]" />
        </label>
        <label className="flex flex-col gap-1 text-xs text-muted-foreground">
          To
          <Input type="date" value={to} min={from} max={isoToday()} onChange={(e) => onFilterChange(setTo, e.target.value)} className="h-9 w-[9.5rem]" />
        </label>
        <div className="flex flex-1 items-end gap-2 min-w-[16rem]">
          <label className="flex flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Search
            <Input
              type="search"
              placeholder="order id, campaign, courier, status…"
              value={searchInput}
              onChange={(e) => setSearchInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') applySearch(); }}
              className="h-9"
            />
          </label>
          <Button variant="secondary" onClick={applySearch} className="h-9">
            <SearchIcon className="mr-1.5 h-4 w-4" /> Search
          </Button>
        </div>
      </div>

      {/* Table */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-2 pb-3">
          <CardTitle className="text-sm font-medium text-muted-foreground">
            {total.toLocaleString()} record{total === 1 ? '' : 's'}
            {isFetching && !isLoading ? <span className="ml-2 text-xs opacity-60">updating…</span> : null}
          </CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          {error ? (
            <div className="p-6 text-sm text-destructive">Couldn’t load records. Try again.</div>
          ) : isLoading ? (
            <div className="space-y-2 p-4">
              {Array.from({ length: 8 }).map((_, i) => <Skeleton key={i} className="h-9 w-full" />)}
            </div>
          ) : rows.length === 0 ? (
            <div className="p-10 text-center text-sm text-muted-foreground">
              No records in this window{search ? ` matching “${search}”` : ''}. Try widening the date range or clearing the search.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b bg-muted/40 text-left text-xs uppercase tracking-wide text-muted-foreground">
                    {columns.map((c) => (
                      <th key={c.key} className={cn('px-4 py-2.5 font-medium', (c.type === 'money' || c.type === 'number') && 'text-right')}>
                        {c.label}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row, ri) => (
                    <tr key={ri} className="border-b last:border-0 hover:bg-muted/30">
                      {columns.map((c) => (
                        <td
                          key={c.key}
                          className={cn(
                            'px-4 py-2.5',
                            (c.type === 'money' || c.type === 'number') && 'text-right tabular-nums',
                            c.type === 'text' && 'font-mono text-xs',
                          )}
                          title={row[c.key] ?? undefined}
                        >
                          {formatCell(row[c.key], c, row)}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardContent>
      </Card>

      {/* Pagination */}
      {total > 0 && (
        <div className="flex items-center justify-between text-sm text-muted-foreground">
          <span>Showing {startRow.toLocaleString()}–{endRow.toLocaleString()} of {total.toLocaleString()}</span>
          <div className="flex items-center gap-2">
            <Button variant="outline" size="sm" disabled={page <= 1 || isFetching} onClick={() => setPage((p) => Math.max(1, p - 1))}>
              Previous
            </Button>
            <span className="tabular-nums">Page {page} of {totalPages.toLocaleString()}</span>
            <Button variant="outline" size="sm" disabled={page >= totalPages || isFetching} onClick={() => setPage((p) => p + 1)}>
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
