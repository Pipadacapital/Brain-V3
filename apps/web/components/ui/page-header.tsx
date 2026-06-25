import * as React from 'react';
import { cn } from '@/lib/utils';

interface PageHeaderProps {
  title: React.ReactNode;
  description?: React.ReactNode;
  /** Right-aligned actions (buttons, filters). */
  actions?: React.ReactNode;
  /** Optional eyebrow/breadcrumb row above the title. */
  eyebrow?: React.ReactNode;
  /** Optional trust row (freshness, confidence, status) shown under the title. */
  meta?: React.ReactNode;
  className?: string;
}

/**
 * PageHeader — the single, consistent page title block for every route.
 * Always renders an <h1>. Pages must use this rather than ad-hoc headings so
 * hierarchy and spacing stay identical app-wide.
 *
 * Trust: use `meta` to surface freshness/confidence (FreshnessIndicator,
 * ConfidenceMeter, StatusBadge) — Brain shows how fresh + how confident data
 * is, prominently and near the title.
 */
export function PageHeader({
  title,
  description,
  actions,
  eyebrow,
  meta,
  className,
}: PageHeaderProps) {
  return (
    <header className={cn('flex flex-col gap-4 pb-6 sm:flex-row sm:items-start sm:justify-between', className)}>
      <div className="min-w-0 space-y-1.5">
        {eyebrow && (
          <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            {eyebrow}
          </div>
        )}
        <h1 className="text-2xl font-semibold tracking-tight text-foreground">{title}</h1>
        {description && (
          <p className="max-w-2xl text-sm text-muted-foreground">{description}</p>
        )}
        {meta && <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 pt-1">{meta}</div>}
      </div>
      {actions && <div className="flex flex-shrink-0 items-center gap-2">{actions}</div>}
    </header>
  );
}
