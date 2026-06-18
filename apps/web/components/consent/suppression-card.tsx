'use client';

/**
 * SuppressionCard — the fail-closed marketing-suppression summary.
 *
 * Shows how many subjects are SUPPRESSED for marketing (no consent OR withdrawn OR
 * tombstoned) vs marketing-granted. The suppressed count is the headline: it is the
 * number of subjects can_contact() will BLOCK for a marketing send right now.
 *
 * A11y: KpiTile renders value+label as text (role=region + aria-label); the "fail-
 * closed" status is conveyed by an icon + word, never colour alone.
 */

import { ShieldOff, ShieldCheck, Trash2 } from 'lucide-react';
import { KpiTile } from '@/components/analytics/kpi-tile';
import type { ConsentSuppressionSummaryResponse } from '@/lib/api/types';

function fmtCount(s: string): string {
  try {
    return BigInt(s).toLocaleString('en-IN');
  } catch {
    return s;
  }
}

export function SuppressionCard({
  data,
}: {
  data: Extract<ConsentSuppressionSummaryResponse, { state: 'has_data' }>;
}) {
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-3"
      data-testid="consent-suppression-card"
      aria-label="Marketing suppression summary"
    >
      <KpiTile
        label="Suppressed (marketing)"
        value={fmtCount(data.suppressed_subjects)}
        sublabel="blocked for marketing sends"
        data-testid="consent-suppressed-count"
      />
      <KpiTile
        label="Withdrawn / erased"
        value={fmtCount(data.tombstoned_subjects)}
        sublabel="have a consent tombstone"
        data-testid="consent-tombstoned-count"
      />
      <KpiTile
        label="Marketing granted"
        value={fmtCount(data.granted_subjects)}
        sublabel="sendable (consent on file)"
        data-testid="consent-granted-count"
      />
      <p className="sr-only">
        <ShieldOff aria-hidden="true" /> Suppressed subjects are blocked.{' '}
        <ShieldCheck aria-hidden="true" /> Granted subjects are sendable.{' '}
        <Trash2 aria-hidden="true" /> Tombstoned subjects have withdrawn or been erased.
      </p>
    </div>
  );
}
