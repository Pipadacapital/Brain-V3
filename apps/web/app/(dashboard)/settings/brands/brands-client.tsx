'use client';

/**
 * BrandsClient — lists ALL of the workspace's active brands and offers a "Delete" action that
 * archives (soft-deletes) each one. This is the dedicated home for brand management after the
 * delete control was removed from the brand switcher (the switcher is for switching, not editing).
 *
 * Data source:
 *   - useBrandSummary() → { brands: [...], active_brand_id }  (same org-scoped set the switcher shows)
 *   - brandApi.remove(id) → DELETE /api/v1/brands/:id          (archive / soft-delete; reversible)
 *
 * "Delete" archives, it does not hard-delete: the brand drops out of the switcher and stops
 * ingesting, but is recoverable from Settings → Archived Brands. We guard the CURRENTLY ACTIVE
 * brand (you must switch away first) so you never archive the brand you're working in.
 *
 * Trust: honest EmptyState / loading / error states; a two-step inline confirm before archiving;
 * a toast on success/failure. On success we invalidate the dashboard query so the switcher updates.
 */

import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Building2, Trash2, Pencil } from 'lucide-react';
import { EditBrandDialog } from '@/components/dashboard/edit-brand-dialog';
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
import { useBrandSummary } from '@/lib/hooks/use-dashboard';
import { DASHBOARD_QUERY_KEY } from '@/lib/hooks/use-dashboard';
import { brandApi, userFacingMessage } from '@/lib/api/client';

export function BrandsClient() {
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useBrandSummary();
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [editBrand, setEditBrand] = useState<{ id: string; display_name: string } | null>(null);

  const brands = data?.brands ?? [];
  const activeBrandId = data?.active_brand_id ?? null;

  async function handleDelete(brand: { id: string; display_name: string }) {
    setDeletingId(brand.id);
    try {
      await brandApi.remove(brand.id);
      toast({
        title: 'Brand deleted',
        description: `"${brand.display_name}" was archived. Restore it any time from Settings → Archived Brands.`,
      });
      setConfirmId(null);
      // Refresh the switcher + this list.
      await queryClient.invalidateQueries({ queryKey: DASHBOARD_QUERY_KEY });
    } catch (err) {
      toast({
        title: 'Could not delete brand',
        description: userFacingMessage(err),
        variant: 'destructive',
      });
    } finally {
      setDeletingId(null);
    }
  }

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Settings"
        title="Brands"
        description="All the brands in your workspace. Edit a brand's profile, or delete (archive) one to remove it from the switcher and stop syncing its data — archived brands stay recoverable from Archived Brands."
      />

      <SectionCard
        title="Your brands"
        description="Edit updates the brand profile (name, website, timezone, region). Deleting archives the brand (reversible) — you can't delete the brand you're currently in, switch away first."
        flush
      >
        {error ? (
          <div className="p-5">
            <ErrorCard error={error} retry={refetch} />
          </div>
        ) : isLoading ? (
          <div className="space-y-2 p-5" aria-busy="true" aria-label="Loading brands">
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
            <Skeleton className="h-10 w-full" />
          </div>
        ) : brands.length === 0 ? (
          <EmptyState
            icon={<Building2 aria-hidden="true" />}
            title="No brands yet"
            description="Brands you create appear here. You don't have any active brands right now."
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
              {brands.map((brand) => {
                const isActive = brand.id === activeBrandId;
                const isConfirming = confirmId === brand.id;
                return (
                  <TableRow key={brand.id} data-testid={`brand-row-${brand.id}`}>
                    <TableCell className="font-medium text-foreground">
                      {brand.display_name}
                      {isActive && (
                        <StatusBadge tone="info" className="ml-2 align-middle">
                          Current
                        </StatusBadge>
                      )}
                    </TableCell>
                    <TableCell className="text-muted-foreground">{brand.domain ?? '—'}</TableCell>
                    <TableCell>
                      <StatusBadge tone="success">Active</StatusBadge>
                    </TableCell>
                    <TableCell className="text-right">
                      {isConfirming ? (
                        <span className="inline-flex items-center gap-2">
                          <span className="text-xs text-muted-foreground">Delete?</span>
                          <Button
                            size="sm"
                            variant="destructive"
                            onClick={() => handleDelete(brand)}
                            loading={deletingId === brand.id}
                            disabled={deletingId !== null}
                            aria-label={`Confirm delete brand ${brand.display_name}`}
                            data-testid={`btn-confirm-delete-brand-${brand.id}`}
                          >
                            Confirm
                          </Button>
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => setConfirmId(null)}
                            disabled={deletingId !== null}
                            aria-label="Cancel delete"
                          >
                            Cancel
                          </Button>
                        </span>
                      ) : (
                        <span className="inline-flex items-center justify-end gap-2">
                          <Button
                            size="sm"
                            variant="outline"
                            onClick={() =>
                              setEditBrand({ id: brand.id, display_name: brand.display_name })
                            }
                            disabled={deletingId !== null}
                            aria-label={`Edit brand ${brand.display_name}`}
                            data-testid={`btn-edit-brand-${brand.id}`}
                          >
                            <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                            Edit
                          </Button>
                          {isActive ? (
                            <span className="text-xs text-muted-foreground">Switch away to delete</span>
                          ) : (
                            <Button
                              size="sm"
                              variant="outline"
                              onClick={() => setConfirmId(brand.id)}
                              disabled={deletingId !== null}
                              aria-label={`Delete brand ${brand.display_name}`}
                              data-testid={`btn-delete-brand-${brand.id}`}
                            >
                              <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                              Delete
                            </Button>
                          )}
                        </span>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        )}
      </SectionCard>

      <EditBrandDialog
        brand={editBrand}
        open={editBrand !== null}
        onOpenChange={(o) => {
          if (!o) setEditBrand(null);
        }}
      />
    </div>
  );
}
