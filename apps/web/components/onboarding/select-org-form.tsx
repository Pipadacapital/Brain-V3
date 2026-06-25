'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';
import { Loader2, Building2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
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
    <Card>
      <CardHeader>
        <CardTitle>Select a workspace</CardTitle>
        <CardDescription>
          You belong to multiple workspaces. Choose which one to open.
        </CardDescription>
      </CardHeader>
      <CardContent>
        {selectError && (
          <p className="mb-4 text-sm text-destructive" role="alert">
            {selectError}
          </p>
        )}
        <div className="space-y-3" role="list" aria-label="Workspaces">
          {workspaces.map((ws) => (
            <div
              key={ws.id}
              role="listitem"
              className="flex items-center justify-between rounded-md border p-4 hover:bg-muted/50 transition-colors"
            >
              <div className="flex items-center gap-3 min-w-0">
                <Building2 className="h-5 w-5 shrink-0 text-muted-foreground" aria-hidden="true" />
                <div className="min-w-0">
                  <p className="font-medium text-sm truncate">{ws.name}</p>
                  <p className="text-xs text-muted-foreground truncate">{ws.slug}</p>
                </div>
              </div>
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleSelect(ws.id)}
                disabled={selectingId !== null}
                aria-label={`Open workspace ${ws.name}`}
                data-testid={`btn-select-org-${ws.id}`}
              >
                {selectingId === ws.id ? (
                  <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
                ) : (
                  'Open'
                )}
              </Button>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
