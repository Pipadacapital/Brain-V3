'use client';

import { Building2, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
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
      <Card>
        <CardHeader>
          <Skeleton className="h-5 w-32" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-7 w-48" />
          <Skeleton className="h-4 w-24" />
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <Card>
        <CardContent className="pt-6">
          <ErrorCard error={error} retry={refetch} />
        </CardContent>
      </Card>
    );
  }

  if (!data) {
    return (
      <Card>
        <CardContent className="pt-6">
          <EmptyState
            title="No brand yet"
            description="Create a workspace and brand to get started."
            icon={<Building2 className="h-8 w-8" />}
          />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card data-testid="brand-summary-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
          <Building2 className="h-4 w-4" aria-hidden="true" />
          Brand Summary
        </CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">{data.workspace_name}</p>
        <h2 className="text-xl font-bold text-foreground mt-0.5">{data.brand_name}</h2>
        <div className="mt-3 flex items-center gap-1.5 text-sm text-muted-foreground">
          <Users className="h-4 w-4" aria-hidden="true" />
          <span>
            {data.member_count === 1 ? '1 member' : `${data.member_count} members`}
          </span>
        </div>
      </CardContent>
    </Card>
  );
}
