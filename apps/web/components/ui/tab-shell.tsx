'use client';

import * as React from 'react';
import { PageHeader } from '@/components/ui/page-header';
import { ExplainerPanel, type ExplainerPanelProps } from '@/components/ui/explainer-panel';

/**
 * TabShell — the standard frame for every top-level tab in the redesigned IA.
 *
 * Pure composition over existing primitives (PageHeader + ExplainerPanel) so all 8
 * tabs are visually identical: a title + the question the tab answers, the permanent
 * "?" explainer in the actions slot, an optional controls slot (DateRangeFilter, model
 * selectors), an optional freshness row, then the tab's content.
 *
 * Tab agents render <TabShell ...>{content}</TabShell> and never touch nav/shared files.
 */
export interface TabShellProps {
  /** Tab name. */
  title: React.ReactNode;
  /** The single business question this tab answers (shown as the description). */
  description?: React.ReactNode;
  /** Optional eyebrow/breadcrumb above the title. */
  eyebrow?: React.ReactNode;
  /** The permanent "?" explainer config for this tab. */
  explainer: ExplainerPanelProps;
  /** Extra header controls placed LEFT of the explainer (e.g. DateRangeFilter, selectors). */
  actions?: React.ReactNode;
  /** Trust row under the title — typically a <FreshnessBadge> for the page as a whole. */
  freshness?: React.ReactNode;
  children?: React.ReactNode;
}

export function TabShell({
  title,
  description,
  eyebrow,
  explainer,
  actions,
  freshness,
  children,
}: TabShellProps) {
  return (
    <div className="space-y-6">
      <PageHeader
        title={title}
        description={description}
        eyebrow={eyebrow}
        meta={freshness}
        actions={
          <>
            {actions}
            <ExplainerPanel {...explainer} />
          </>
        }
      />
      {children}
    </div>
  );
}
