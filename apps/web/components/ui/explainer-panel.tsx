'use client';

import * as React from 'react';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import { HelpCircle, X } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';

/**
 * ExplainerPanel — the permanent "?" side panel that lives on every tab.
 *
 * Self-explanatory IA (Brain): each tab answers ONE business question. The
 * explainer states WHAT the metrics mean, HOW they're computed, the refresh
 * cadence, and the data sources — so a user never guesses. Right-anchored sheet
 * built on Radix Dialog (accessible: focus trap, Esc, labelled).
 *
 * Renders its OWN trigger (a small "?" button) — drop it straight into
 * PageHeader.actions / TabShell. No external state needed.
 */

export interface ExplainerMetric {
  /** Display name of the metric. */
  name: string;
  /** Plain-language definition — what it measures. */
  definition: string;
  /** Optional: how it's computed (source mart, formula, window). */
  howComputed?: string;
}

export interface ExplainerSection {
  heading: string;
  body: React.ReactNode;
}

export interface ExplainerPanelProps {
  /** Panel title — usually the tab name + the question it answers. */
  title: string;
  /** One-line summary under the title. */
  description?: React.ReactNode;
  /** Free-form prose sections (context, how to read the page, caveats). */
  sections?: ExplainerSection[];
  /** Per-metric definitions + how-computed. */
  metrics?: ExplainerMetric[];
  /** Refresh cadence sentence, e.g. "Silver→Gold refresh runs ~every 15 min." */
  refreshCadence?: React.ReactNode;
  /** Upstream data sources, e.g. ["Gold mv_gold_revenue_ledger", "Shopify orders"]. */
  sources?: string[];
  /** Override the trigger's accessible label. */
  triggerLabel?: string;
  /** Extra classes on the trigger button. */
  triggerClassName?: string;
}

export function ExplainerPanel({
  title,
  description,
  sections,
  metrics,
  refreshCadence,
  sources,
  triggerLabel,
  triggerClassName,
}: ExplainerPanelProps) {
  return (
    <DialogPrimitive.Root>
      <DialogPrimitive.Trigger asChild>
        <Button
          variant="outline"
          size="icon-sm"
          aria-label={triggerLabel ?? `What does this page show? — ${title}`}
          className={cn(triggerClassName)}
        >
          <HelpCircle className="size-4" aria-hidden="true" />
        </Button>
      </DialogPrimitive.Trigger>

      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          className="fixed inset-0 z-50 bg-black/40 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0"
        />
        <DialogPrimitive.Content
          className={cn(
            'fixed right-0 top-0 z-50 flex h-full w-full max-w-md flex-col border-l border-border bg-background shadow-lg',
            'data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right duration-200',
          )}
        >
          {/* Header */}
          <div className="flex items-start justify-between gap-3 border-b border-border p-5">
            <div className="min-w-0 space-y-1">
              <DialogPrimitive.Title className="text-base font-semibold leading-tight tracking-tight text-foreground">
                {title}
              </DialogPrimitive.Title>
              {description && (
                <DialogPrimitive.Description className="text-sm text-muted-foreground">
                  {description}
                </DialogPrimitive.Description>
              )}
            </div>
            <DialogPrimitive.Close
              className="shrink-0 rounded-sm opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2"
              aria-label="Close"
            >
              <X className="size-4" aria-hidden="true" />
            </DialogPrimitive.Close>
          </div>

          {/* Body */}
          <div className="flex-1 space-y-6 overflow-y-auto p-5 text-sm">
            {sections?.map((s) => (
              <section key={s.heading} className="space-y-1.5">
                <h3 className="text-sm font-semibold text-foreground">{s.heading}</h3>
                <div className="text-sm leading-relaxed text-muted-foreground">{s.body}</div>
              </section>
            ))}

            {metrics && metrics.length > 0 && (
              <section className="space-y-3">
                <h3 className="text-sm font-semibold text-foreground">Metrics on this page</h3>
                <dl className="space-y-3">
                  {metrics.map((m) => (
                    <div key={m.name} className="rounded-md border border-border bg-muted/30 p-3">
                      <dt className="text-sm font-medium text-foreground">{m.name}</dt>
                      <dd className="mt-1 text-sm leading-relaxed text-muted-foreground">
                        {m.definition}
                        {m.howComputed && (
                          <span className="mt-1 block text-xs text-muted-foreground/80">
                            <span className="font-medium">How it's computed: </span>
                            {m.howComputed}
                          </span>
                        )}
                      </dd>
                    </div>
                  ))}
                </dl>
              </section>
            )}

            {refreshCadence && (
              <section className="space-y-1.5">
                <h3 className="text-sm font-semibold text-foreground">Refresh cadence</h3>
                <div className="text-sm leading-relaxed text-muted-foreground">{refreshCadence}</div>
              </section>
            )}

            {sources && sources.length > 0 && (
              <section className="space-y-1.5">
                <h3 className="text-sm font-semibold text-foreground">Data sources</h3>
                <ul className="list-inside list-disc space-y-1 text-sm text-muted-foreground">
                  {sources.map((src) => (
                    <li key={src}>{src}</li>
                  ))}
                </ul>
              </section>
            )}
          </div>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
