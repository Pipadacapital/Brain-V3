'use client';

/**
 * AskBrainContent — the "Ask Brain" Decision-Intelligence surface (Phase 8, requirement §6).
 *
 * BFF-ONLY: this view reads ONLY POST /api/v1/ask (the metric-engine sole read path, I-ST01).
 * It NEVER queries metric tables / StarRocks and NEVER calls the model directly. The model
 * resolves the question to a registry binding; the metric-engine computes the certified number.
 *
 * The honesty UX (the moat):
 *   - answer  → resolved BINDING + certified NUMBER + Trusted/Estimated BANNER + PROVENANCE.
 *   - no_data → the binding resolved but the brand has no data for it (honest-empty, NO number).
 *   - refusal → off-domain / unresolvable: the honest "no certified metric answers this" card,
 *               with NO number shown. The model fabricates nothing.
 *
 * A11y: the question form has a labelled input; the answer region uses aria-live so the verdict
 * is announced; the trust banner is icon + label (never colour-only); request_id surfaces on error.
 */

import * as React from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Sparkles, BrainCircuit, SearchX, Inbox } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { PageHeader as PageHeaderPrimitive } from '@/components/ui/page-header';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { useAsk } from '@/lib/hooks/use-ask';
import { askBrainSchema, type AskBrainFormValues } from '@/lib/api/schemas';
import {
  AskBindingBadge,
  AskCertifiedNumber,
  AskTrustBanner,
  AskProvenance,
} from '@/components/ask/ask-result';

const SAMPLE_QUESTIONS = [
  'How much revenue did we realize?',
  'What is our blended ROAS?',
  'What is the CoD RTO rate?',
];

function PageHeader() {
  return (
    <PageHeaderPrimitive
      eyebrow={
        <span className="inline-flex items-center gap-1.5 normal-case tracking-normal">
          <BrainCircuit className="h-3.5 w-3.5" aria-hidden="true" />
          Decision intelligence
        </span>
      }
      title="Ask Brain"
      description={
        <>
          Ask a question about your metrics in plain language. Brain resolves it to a{' '}
          <strong className="font-medium text-foreground">certified metric</strong> and the
          metric-engine computes the number — it never makes one up. Every answer shows its
          binding, confidence, and snapshot so you can trace it.{' '}
          <span className="font-medium text-foreground">Computed, not generated.</span>
        </>
      }
    />
  );
}

export function AskBrainContent() {
  const ask = useAsk();
  const { data, error, isPending, isError, reset } = ask;

  const form = useForm<AskBrainFormValues>({
    resolver: zodResolver(askBrainSchema),
    defaultValues: { question: '' },
  });

  const onSubmit = (values: AskBrainFormValues) => {
    ask.mutate(values.question);
  };

  const submitQuestion = (q: string) => {
    form.setValue('question', q);
    ask.mutate(q);
  };

  return (
    <div className="space-y-6">
      <PageHeader />

      {/* ── The question form ── */}
      <Card>
        <CardContent className="pt-6">
          <form
            onSubmit={form.handleSubmit(onSubmit)}
            className="space-y-3"
            aria-label="Ask Brain a question"
          >
            <label htmlFor="ask-question" className="sr-only">
              Your question
            </label>
            <div className="flex flex-col gap-2 sm:flex-row">
              <Input
                id="ask-question"
                placeholder="e.g. How much revenue did we realize last month?"
                autoComplete="off"
                data-testid="ask-input"
                aria-invalid={form.formState.errors.question ? true : undefined}
                {...form.register('question')}
              />
              <Button
                type="submit"
                disabled={isPending}
                data-testid="ask-submit"
                className="shrink-0"
              >
                <Sparkles className="h-4 w-4" aria-hidden="true" />
                {isPending ? 'Asking…' : 'Ask'}
              </Button>
            </div>
            {form.formState.errors.question && (
              <p className="text-sm text-destructive" role="alert">
                {form.formState.errors.question.message}
              </p>
            )}
          </form>

          {/* Sample questions — quick starts (no result yet) */}
          {!data && !isPending && !isError && (
            <div className="mt-4 flex flex-wrap items-center gap-2">
              <span className="text-xs text-muted-foreground">Try:</span>
              {SAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  type="button"
                  onClick={() => submitQuestion(q)}
                  className="rounded-full border border-border bg-muted px-3 py-1 text-xs text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-1"
                  data-testid="ask-sample"
                >
                  {q}
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      {/* ── The answer region (aria-live so the verdict is announced) ── */}
      <section aria-live="polite" aria-label="Answer" className="space-y-4">
        {isPending && (
          <Card data-testid="ask-loading">
            <CardContent className="space-y-3 pt-6">
              <Skeleton className="h-4 w-40 rounded" />
              <Skeleton className="h-10 w-56 rounded" />
              <Skeleton className="h-16 w-full rounded-lg" />
            </CardContent>
          </Card>
        )}

        {isError && (
          <ErrorCard
            error={error}
            retry={() => {
              reset();
              const q = form.getValues('question');
              if (q) ask.mutate(q);
            }}
          />
        )}

        {data && !isPending && (
          <>
            {data.kind === 'answer' && data.number.no_data && (
              // Honest-empty: the binding resolved but the brand has no data for it (NO number).
              <Card data-testid="ask-no-data">
                <CardContent className="space-y-4 pt-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <AskBindingBadge binding={data.binding} />
                  </div>
                  <EmptyState
                    title="No data yet for this metric"
                    description="Brain resolved your question to a certified metric, but there's no data to compute it for your brand yet. Connect a source or wait for ingestion, then ask again."
                    icon={<Inbox className="h-8 w-8" aria-hidden="true" />}
                  />
                  <AskProvenance
                    binding={data.binding}
                    snapshotId={data.binding.snapshot_id}
                    grade={data.confidence_grade}
                  />
                </CardContent>
              </Card>
            )}

            {data.kind === 'answer' && !data.number.no_data && (
              <Card data-testid="ask-answer">
                <CardContent className="space-y-4 pt-6">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <AskBindingBadge binding={data.binding} />
                  </div>
                  <AskCertifiedNumber number={data.number} />
                  <AskTrustBanner tier={data.trust_tier} grade={data.confidence_grade} />
                  <AskProvenance
                    binding={data.binding}
                    snapshotId={data.binding.snapshot_id}
                    grade={data.confidence_grade}
                  />
                </CardContent>
              </Card>
            )}

            {data.kind === 'refusal' && (
              <Card data-testid="ask-refusal">
                <CardContent className="pt-6">
                  <EmptyState
                    title="No certified metric answers this"
                    description={
                      data.reason ||
                      "Brain only answers from certified metrics it can compute deterministically. This question doesn't map to one — so no number is shown. Try rephrasing around revenue, spend, ROAS, RTO, orders, journeys, or attribution."
                    }
                    icon={<SearchX className="h-8 w-8" aria-hidden="true" />}
                  />
                  {/* The honesty headline: a refusal shows NO number — that is the correct outcome. */}
                  <p
                    className="mt-2 text-center text-xs italic text-muted-foreground"
                    data-testid="ask-refusal-note"
                  >
                    Brain never fabricates a number — when it can&apos;t certify an answer, it says so.
                  </p>
                </CardContent>
              </Card>
            )}
          </>
        )}
      </section>
    </div>
  );
}
