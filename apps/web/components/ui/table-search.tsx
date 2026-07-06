'use client';

/**
 * TableSearch — the shared search box for records tables. A controlled text input with a
 * search icon and a clear button, so every records page filters its rows the same way.
 *
 * It is presentation only: the caller owns the query string and does the filtering over the
 * rows it already holds (client-side, case-insensitive substring). It never re-fetches and
 * never computes a metric — money/counts stay exactly as the engine returned them; search
 * only narrows which already-loaded rows are shown.
 *
 * A11y: role=searchbox via type="search", a labelled input, and a clear button that is only
 * present when there is text to clear.
 */

import * as React from 'react';
import { Search, X } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface TableSearchProps {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  className?: string;
  'aria-label'?: string;
}

export function TableSearch({
  value,
  onChange,
  placeholder = 'Search…',
  className,
  'aria-label': ariaLabel = 'Search records',
}: TableSearchProps) {
  return (
    <div className={cn('relative w-full sm:w-64', className)}>
      <Search
        className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <input
        type="search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        aria-label={ariaLabel}
        className={cn(
          'flex h-9 w-full rounded-md border border-input bg-surface pl-8 pr-8 py-1 text-sm text-foreground shadow-xs transition-colors',
          'placeholder:text-muted-foreground',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background focus-visible:border-ring',
          // Hide the native search clear affordance — we render our own consistent one.
          '[&::-webkit-search-cancel-button]:appearance-none',
        )}
      />
      {value && (
        <button
          type="button"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-0.5 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label="Clear search"
        >
          <X className="size-4" aria-hidden="true" />
        </button>
      )}
    </div>
  );
}

/**
 * matchesQuery — the canonical case-insensitive substring helper for table filtering.
 * Pass the row's searchable fields (already-stringified) and the query; empty query matches all.
 */
export function matchesQuery(query: string, ...fields: Array<string | null | undefined>): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return fields.some((f) => (f ?? '').toLowerCase().includes(q));
}

/**
 * filterRows — pure, case-insensitive substring filter over a row list. Give it the fields
 * (keys) to search, or a string accessor that flattens the row into searchable text. An
 * empty/whitespace query returns a shallow copy of all rows (narrows nothing, fabricates
 * nothing). Built on matchesQuery so behaviour stays identical everywhere.
 *
 * @example filterRows(orders, q, ['order_name', 'customer_email'])
 * @example filterRows(orders, q, (o) => `${o.order_name} ${o.customer_email}`)
 */
export function filterRows<T>(
  rows: readonly T[],
  query: string,
  fields: readonly (keyof T)[] | ((row: T) => string),
): T[] {
  const q = query.trim();
  if (!q) return rows.slice();

  if (typeof fields === 'function') {
    return rows.filter((row) => matchesQuery(q, fields(row)));
  }

  return rows.filter((row) =>
    matchesQuery(
      q,
      ...fields.map((f) => {
        const v = row[f];
        return v == null ? '' : String(v);
      }),
    ),
  );
}
