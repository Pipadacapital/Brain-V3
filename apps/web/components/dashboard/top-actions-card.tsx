'use client';

/**
 * TopActionsCard — the "Decide" surface on the dashboard (doc 09: "the unit of output is a decision,
 * not a chart"). Surfaces the brand's top 3 ACTIONABLE recommendations (highest priority, not held),
 * from the existing decision engine (useRecommendations). Held items are not shown here — they live
 * on the full Recommendations page as a "improve your foundation" step. Honest empty when there are
 * no open actions. Money in evidence is minor-units; this compact card shows title/summary only.
 */
import Link from 'next/link';
import { AlertTriangle, TrendingUp, ShieldCheck, ShieldAlert, ArrowRight, Lightbulb } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { useRecommendations } from '@/lib/hooks/use-recommendations';
import type { Recommendation } from '@/lib/api/types';

function ConfidenceBadge({ c }: { c: Recommendation['confidence'] }) {
  if (c === 'Trusted') return <Badge className="gap-1 bg-emerald-600 text-[10px]"><ShieldCheck className="h-3 w-3" /> Trusted</Badge>;
  return <Badge variant="secondary" className="gap-1 text-[10px]"><ShieldAlert className="h-3 w-3" /> {c}</Badge>;
}

export function TopActionsCard() {
  const { data, isLoading } = useRecommendations();

  const actionable: Recommendation[] =
    data?.state === 'has_data' ? data.recommendations.filter((r) => !r.held).sort((a, b) => b.priority - a.priority).slice(0, 3) : [];

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 pb-2">
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Lightbulb className="h-4 w-4 text-amber-500" aria-hidden="true" /> Top actions
        </CardTitle>
        <Link href="/recommendations" className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground">
          View all <ArrowRight className="h-3 w-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {isLoading && (
          <div className="space-y-2">
            {Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-12 w-full" />)}
          </div>
        )}

        {!isLoading && actionable.length === 0 && (
          <p className="py-2 text-sm text-muted-foreground">
            No actions right now. As your data fills in (orders, costs, connectors), Brain surfaces the
            highest-impact decisions here.
          </p>
        )}

        {!isLoading && actionable.length > 0 && (
          <ul className="divide-y">
            {actionable.map((r) => (
              <li key={r.recommendation_id} className="flex items-start gap-3 py-3 first:pt-0 last:pb-0">
                <span className="mt-0.5">
                  {r.kind === 'risk'
                    ? <AlertTriangle className="h-4 w-4 text-amber-600" aria-hidden="true" />
                    : <TrendingUp className="h-4 w-4 text-emerald-600" aria-hidden="true" />}
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
      </CardContent>
    </Card>
  );
}
