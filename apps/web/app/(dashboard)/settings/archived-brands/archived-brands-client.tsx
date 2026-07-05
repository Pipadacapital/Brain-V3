'use client';

/**
 * ArchivedBrandsClient — lists the workspace's ARCHIVED (soft-deleted) brands and
 * offers a "Restore" action that un-archives each one.
 *
 * Data source:
 *   - GET  /api/v1/dashboard/archived-brands → { data: { brands: [...] } }
 *   - PATCH /api/v1/brands/:id { status: 'active' } → restore (brand.service.update)
 *
 * Archived brands are intentionally hidden from the brand switcher (the switcher only
 * lists active brands) so the working surface stays uncluttered. This page is the one
 * honest place a workspace can see what was archived and bring it back. Restoring re-adds
 * the brand to the switcher and resumes its data foundation.
 *
 * Trust: an honest EmptyState when nothing is archived (never a fabricated/blank panel),
 * inline ErrorCard on load failure with retry, and a toast confirmation on restore.
 *
 * NOTE: this slice may not edit the shared API client (apps/web/lib/api/client.ts is owned
 * by the web-api foundation slice), so the two BFF calls are made through a small local
 * fetch helper that mirrors the shared client's CSRF + error-envelope behaviour. Flagged in
 * followups for consolidation into brandApi.{listArchived,restore} later.
 */

import { useCallback, useEffect, useState } from 'react';
import { Archive, RotateCcw } from 'lucide-react';
import { PageHeader } from '@/components/ui/page-header';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { ErrorCard } from '@/components/ui/error-card';
import { StatusBadge } from '@/components/ui/status-badge';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { toast } from '@/components/ui/toaster';
import { BffApiError, userFacingMessage } from '@/lib/api/client';

interface ArchivedBrand {
  id: string;
  display_name: string;
  domain: string | null;
  status: string;
}

const BFF_BASE = '/api/bff';
const CSRF_COOKIE = 'brain_csrf';

function readCsrfCookie(): string | undefined {
  if (typeof document === 'undefined') return undefined;
  const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
  return match ? decodeURIComponent(match[1]!) : undefined;
}

/**
 * Minimal BFF fetch — credentials + CSRF + error envelope, mirroring the shared client.
 * Local to this slice (cannot edit the shared client). On a non-OK response it throws a
 * BffApiError so userFacingMessage() renders a clean, customer-safe string.
 */
async function bffCall<T>(path: string, init?: RequestInit): Promise<T> {
  const method = (init?.method ?? 'GET').toUpperCase();
  const isMutation = method !== 'GET' && method !== 'HEAD';

  let csrf = isMutation ? readCsrfCookie() : undefined;
  if (isMutation && !csrf) {
    await fetch(`${BFF_BASE}/v1/bff/csrf`, { credentials: 'include' });
    csrf = readCsrfCookie();
  }

  const headers: Record<string, string> = {
    ...(init?.body != null ? { 'Content-Type': 'application/json' } : {}),
    ...(csrf ? { 'x-csrf-token': csrf } : {}),
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
  };

  const res = await fetch(`${BFF_BASE}${path}`, {
    ...init,
    headers,
    credentials: 'include',
  });

  if (!res.ok) {
    let body: { request_id?: string; error?: { code?: string; message?: string } } = {};
    try {
      body = await res.json();
    } catch {
      /* non-JSON */
    }
    const message =
      body?.error?.message ??
      (res.status >= 500
        ? 'Brain had a brief problem on our side. Your data is safe — please try again in a moment.'
        : 'Something went wrong. Please try again.');
    throw new BffApiError(message, res.status, body?.request_id ?? '', body?.error?.code);
  }

  if (res.status === 204) return undefined as unknown as T;
  return res.json() as Promise<T>;
}

export function ArchivedBrandsClient() {
  const [brands, setBrands] = useState<ArchivedBrand[] | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [restoringId, setRestoringId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await bffCall<{ data: { brands: ArchivedBrand[] } }>(
        '/v1/dashboard/archived-brands',
      );
      setBrands(res.data.brands);
    } catch (err) {
      setError(err);
      setBrands(null);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function handleRestore(brand: ArchivedBrand) {
    setRestoringId(brand.id);
    try {
      await bffCall(`/v1/brands/${brand.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ status: 'active' }),
      });
      // Drop the restored brand from this list immediately — it now belongs to the switcher.
      setBrands((prev) => prev?.filter((b) => b.id !== brand.id) ?? null);
      toast({
        title: 'Brand restored',
        description: `"${brand.display_name}" is active again and back in your brand switcher.`,
      });
    } catch (err) {
      toast({
        title: 'Could not restore brand',
        description: userFacingMessage(err),
        variant: 'destructive',
      });
    } finally {
      setRestoringId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Archived brands"
        description="Brands you've archived are hidden from the brand switcher and stop syncing data. Restore one to bring it back and resume syncing."
      />

      <SectionCard
        title="Archived"
        description="Archiving is reversible — nothing is deleted. Restore returns a brand to active."
        flush
      >
        {error ? (
          <div className="p-5">
            <ErrorCard error={error} retry={load} />
          </div>
        ) : brands === null ? (
          <div className="space-y-2 p-5" aria-busy="true" aria-label="Loading archived brands">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : brands.length === 0 ? (
          <EmptyState
            icon={<Archive aria-hidden="true" />}
            title="No archived brands"
            description="When you archive a brand it shows up here so you can restore it later. Nothing is archived right now."
          />
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Brand</TableHead>
                <TableHead>Website</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Action</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {brands.map((brand) => (
                <TableRow key={brand.id} data-testid={`archived-brand-row-${brand.id}`}>
                  <TableCell className="font-medium text-foreground">
                    {brand.display_name}
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {brand.domain ?? '—'}
                  </TableCell>
                  <TableCell>
                    <StatusBadge tone="neutral">Archived</StatusBadge>
                  </TableCell>
                  <TableCell className="text-right">
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => handleRestore(brand)}
                      loading={restoringId === brand.id}
                      disabled={restoringId !== null}
                      aria-label={`Restore brand ${brand.display_name}`}
                      data-testid={`btn-restore-brand-${brand.id}`}
                    >
                      <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                      Restore
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </SectionCard>
    </div>
  );
}
