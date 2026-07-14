'use client';

/**
 * TopActionsCard — the "Decide" surface on the dashboard (doc 09: "the unit of output is a decision,
 * not a chart"). Surfaces the brand's top 3 ACTIONABLE recommendations (highest priority, not held),
 * from the existing decision engine (useRecommendations). Held items are not shown here — they live
 * on the full Recommendations page as a "improve your foundation" step. Honest empty when there are
 * no open actions. Money in evidence is minor-units; this compact card shows title/summary only.
 */
import Link from 'next/link';
import { AlertTriangle, TrendingUp, ShieldCheck, ShieldAlert, ArrowRight } from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { MetricTitle } from '@/components/ui/metric-title';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { EmptyState } from '@/components/ui/empty-state';
import { useRecommendations } from '@/lib/hooks/use-recommendations';
import type { Recommendation } from '@/lib/api/types';

function ConfidenceBadge({ c }: { c: Recommendation['confidence'] }) {
  if (c === 'Trusted') return <Badge variant="success" className="text-[10px]"><ShieldCheck className="h-3 w-3" /> Trusted</Badge>;
  return <Badge variant="secondary" className="text-[10px]"><ShieldAlert className="h-3 w-3" /> {c}</Badge>;
}

export function TopActionsCard() {
  const { data, isLoading } = useRecommendations();

  const actionable: Recommendation[] =
    data?.state === 'has_data' ? data.recommendations.filter((r) => !r.held).sort((a, b) => b.priority - a.priority).slice(0, 3) : [];

  return (
    <SectionCard
      title={
        <MetricTitle
          label="Top actions"
          help="The three highest-impact things Brain suggests you do next, based on your data."
        />
      }
      className="h-full"
      actions={
        <Link
          href="/recommendations"
          className="inline-flex items-center gap-1 rounded text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          View all <ArrowRight className="h-3 w-3" aria-hidden="true" />
        </Link>
      }
    >
      {isLoading && (
        <div className="space-y-2">
          {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
        </div>
      )}

      {!isLoading && actionable.length === 0 && (
        <EmptyState
          compact
          title="No actions right now"
          description="As your data fills in — orders, costs, connectors — Brain surfaces the highest-impact decisions here."
        />
      )}

      {!isLoading && actionable.length > 0 && (
        <ul className="divide-y divide-border">
          {actionable.map((r) => (
            <li key={r.recommendation_id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
              <span className="mt-0.5">
                {r.kind === 'risk'
                  ? <AlertTriangle className="h-4 w-4 text-warning" aria-hidden="true" />
                  : <TrendingUp className="h-4 w-4 text-success" aria-hidden="true" />}
              </span>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <Link href="/recommendations" className="truncate text-sm font-medium hover:underline">{r.title}</Link>
                  <ConfidenceBadge c={r.confidence} />
                </div>
                <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{r.summary}</p>
              </div>
            </li>
          ))}
        </ul>
      )}
    </SectionCard>
  );
}
