'use client';

import { Building2, Users } from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useBrandSummary } from '@/lib/hooks/use-dashboard';

/**
 * Brand Summary widget
 * Source: organization.name, brand.display_name, COUNT over membership
 * (Postgres control-plane ONLY — arch plan §6.4)
 */
export function BrandSummaryCard() {
  const { data, isLoading, error, refetch } = useBrandSummary();

  if (isLoading) {
    return (
      <SectionCard title="Brand summary" className="h-full">
        <div className="space-y-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-24" />
        </div>
      </SectionCard>
    );
  }

  if (error) {
    return (
      <SectionCard title="Brand summary" className="h-full">
        <ErrorCard error={error} retry={refetch} />
      </SectionCard>
    );
  }

  if (!data) {
    return (
      <SectionCard title="Brand summary" className="h-full">
        <EmptyState
          compact
          title="No brand yet"
          description="Create a workspace and brand to get started."
          icon={<Building2 className="h-8 w-8" />}
        />
      </SectionCard>
    );
  }

  return (
    <SectionCard title="Brand summary" className="h-full" data-testid="brand-summary-card">
      <p className="text-xs text-muted-foreground">{data.workspace_name}</p>
      <h2 className="mt-0.5 text-xl font-semibold tracking-tight text-foreground">{data.brand_name}</h2>
      <div className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
        <Users className="h-4 w-4" aria-hidden="true" />
        <span>{data.member_count === 1 ? '1 member' : `${data.member_count} members`}</span>
      </div>
    </SectionCard>
  );
}
