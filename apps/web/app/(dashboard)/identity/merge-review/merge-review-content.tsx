'use client';

/**
 * MergeReviewContent — the identity merge-review queue (P0-C).
 *
 * BFF-ONLY (I-ST01): reads pending candidates from GET /api/v1/identity/merge-reviews and acts
 * via POST /api/v1/identity/merge-reviews/resolve. Each candidate is two brain_ids the resolver
 * flagged as possibly the same person; the operator approves (merge B → A) or rejects.
 *
 * A11y: list items are headed; per-row actions are labelled buttons; the live region announces
 * loading; brain_ids render monospace for scannability.
 */

import { GitMerge, Check, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useMergeReviews, useResolveMergeReview } from '@/lib/hooks/use-identity';
import type { MergeReview } from '@/lib/api/types';

export function MergeReviewContent() {
  const { data, isLoading, isFetching, error, refetch } = useMergeReviews();
  const resolve = useResolveMergeReview();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <GitMerge className="h-6 w-6" aria-hidden="true" />
          Merge Review
        </h1>
        <p className="text-sm text-muted-foreground">
          Candidate identity merges the resolver flagged for human review. Approve to merge the
          second profile into the first, or reject to keep them separate.
        </p>
      </div>

      <div aria-live="polite" aria-busy={isLoading || isFetching}>
        {isLoading ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-24 w-full" />
            <Skeleton className="h-24 w-full" />
          </div>
        ) : error ? (
          <ErrorCard error={error} retry={refetch} />
        ) : !data || data.reviews.length === 0 ? (
          <EmptyState
            icon={<GitMerge className="h-6 w-6" aria-hidden="true" />}
            title="No pending merges"
            description="The review queue is clear — no candidate merges await a decision."
          />
        ) : (
          <ul className="space-y-3">
            {data.reviews.map((r: MergeReview) => (
              <li key={r.review_id}>
                <Card>
                  <CardHeader>
                    <CardTitle className="text-base">{r.trigger_reason}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-wrap items-center justify-between gap-4">
                    <div className="text-sm">
                      <div>
                        Canonical: <span className="font-mono">{r.brain_id_a}</span>
                      </div>
                      <div>
                        Merge in: <span className="font-mono">{r.brain_id_b}</span>
                      </div>
                      <div className="text-muted-foreground">
                        flagged {new Date(r.created_at).toLocaleString()}
                      </div>
                    </div>
                    <div className="flex items-center gap-2">
                      <Button
                        disabled={resolve.isPending}
                        onClick={() => resolve.mutate({ reviewId: r.review_id, decision: 'merge' })}
                      >
                        <Check className="mr-2 h-4 w-4" aria-hidden="true" />
                        Approve merge
                      </Button>
                      <Button
                        variant="outline"
                        disabled={resolve.isPending}
                        onClick={() => resolve.mutate({ reviewId: r.review_id, decision: 'reject' })}
                      >
                        <X className="mr-2 h-4 w-4" aria-hidden="true" />
                        Reject
                      </Button>
                    </div>
                  </CardContent>
                </Card>
              </li>
            ))}
          </ul>
        )}
        {resolve.isError ? (
          <p className="mt-3 text-sm text-destructive">Action failed — please try again.</p>
        ) : null}
      </div>
    </div>
  );
}
