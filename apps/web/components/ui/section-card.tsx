import * as React from 'react';
import { cn } from '@/lib/utils';
import { Card } from './card';

interface SectionCardProps extends Omit<React.HTMLAttributes<HTMLDivElement>, 'title'> {
  title?: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned header controls (filters, links, menus). */
  actions?: React.ReactNode;
  /** Trust row under the title — freshness/confidence/status. */
  meta?: React.ReactNode;
  /** Removes inner content padding (e.g. for an edge-to-edge Table). */
  flush?: boolean;
  /** Footer content rendered in a bordered footer region. */
  footer?: React.ReactNode;
}

/**
 * SectionCard — a titled content block. The default container for a panel of
 * content (a chart, a table, a list). Pair `meta` with FreshnessIndicator /
 * ConfidenceMeter so every data panel can state how fresh + how confident it is.
 */
export function SectionCard({
  title,
  description,
  actions,
  meta,
  flush = false,
  footer,
  className,
  children,
  ...props
}: SectionCardProps) {
  const hasHeader = title || description || actions || meta;
  return (
    <Card className={cn('overflow-hidden', className)} {...props}>
      {hasHeader && (
        <div className="flex flex-col gap-2 border-b border-border p-5 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 space-y-1">
            {title && (
              <h2 className="text-base font-semibold leading-tight tracking-tight text-foreground">
                {title}
              </h2>
            )}
            {description && <p className="text-sm text-muted-foreground">{description}</p>}
            {meta && (
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 pt-0.5">{meta}</div>
            )}
          </div>
          {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className={cn(!flush && 'p-5')}>{children}</div>
      {footer && <div className="border-t border-border bg-muted/30 px-5 py-3 text-sm">{footer}</div>}
    </Card>
  );
}
