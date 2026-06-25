'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Alert } from '@/components/ui/alert';
import { SectionCard } from '@/components/ui/section-card';
import { sessionApi } from '@/lib/api/client';
import { BffApiError, userFacingMessage } from '@/lib/api/client';
import { resolveOnboardingRoute } from '@/components/auth/login-form';
import { useWorkspaceList } from '@/lib/hooks/use-workspace';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';

/**
 * Multi-org selector (F-3).
 *
 * Shown after login when the user belongs to >1 organisation.
 * Calls POST /bff/session/set-org and routes by the returned onboarding_status.
 * Org selection is server-re-verified — never a client-supplied claim override (MA-13).
 */
export function SelectOrgForm() {
  const router = useRouter();
  const { data, isLoading, error, refetch } = useWorkspaceList();
  const [selectingId, setSelectingId] = useState<string | null>(null);
  const [selectError, setSelectError] = useState<string | null>(null);

  async function handleSelect(orgId: string) {
    setSelectingId(orgId);
    setSelectError(null);
    try {
      const result = await sessionApi.setOrg({ organization_id: orgId });
      router.push(resolveOnboardingRoute(result.onboarding_status));
    } catch (err) {
      const msg =
        err instanceof BffApiError
          ? userFacingMessage(err)
          : 'Could not switch workspace. Please try again.';
      setSelectError(msg);
      setSelectingId(null);
    }
  }

  if (isLoading) {
    return (
      <div className="space-y-3" aria-busy="true" aria-label="Loading workspaces…">
        {[1, 2].map((i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
    );
  }

  if (error) {
    return <ErrorCard error={error} retry={refetch} />;
  }

  const workspaces = data?.workspaces ?? [];

  if (workspaces.length === 0) {
    // No orgs → send to workspace creation.
    router.push('/workspace/new');
    return null;
  }

  if (workspaces.length === 1) {
    // Single org — auto-select.
    handleSelect(workspaces[0]!.id);
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" aria-label="Loading…" />
      </div>
    );
  }

  return (
    <SectionCard
      title="Select a workspace"
      description="You belong to multiple workspaces. Choose which one to open."
    >
      {selectError && (
        <Alert variant="destructive" className="mb-4">
          {selectError}
        </Alert>
      )}
      <div className="space-y-3" role="list" aria-label="Workspaces">
        {workspaces.map((ws) => (
          <div
            key={ws.id}
            role="listitem"
            className="flex items-center justify-between gap-3 rounded-lg border border-border p-4 transition-colors hover:bg-muted/50"
          >
            <div className="flex min-w-0 items-center gap-3">
              <span
                className="flex size-9 shrink-0 items-center justify-center rounded-md border border-border bg-muted/60 text-muted-foreground"
                aria-hidden="true"
              >
                <Building2 className="size-4" />
              </span>
              <div className="min-w-0">
                <p className="truncate text-sm font-medium text-foreground">{ws.name}</p>
                <p className="truncate text-xs text-muted-foreground">{ws.slug}</p>
              </div>
            </div>
            <Button
              size="sm"
              variant="outline"
              onClick={() => handleSelect(ws.id)}
              loading={selectingId === ws.id}
              disabled={selectingId !== null}
              aria-label={`Open workspace ${ws.name}`}
              data-testid={`btn-select-org-${ws.id}`}
            >
              {selectingId === ws.id ? '' : 'Open'}
            </Button>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}
