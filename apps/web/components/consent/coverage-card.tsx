'use client';

/**
 * CoverageCard — per-category consent coverage (granted vs withdrawn subjects).
 *
 * The honest consent posture at a glance: for each of the 4 DPDP lawful-basis
 * categories, how many subjects have GRANTED vs are WITHDRAWN/tombstoned. The
 * marketing row is the one that gates outbound sends (can_contact()).
 *
 * A11y: rendered as a real <table> with a caption + scope headers (screen-reader
 * truth, not a colour grid). Granted/withdrawn are paired with an icon + word, never
 * colour alone. Counts are bigint strings rendered via toLocaleString (display only —
 * no client-side math on the raw counts).
 */

import { ShieldCheck, ShieldX } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import type { ConsentCoverageResponse, ConsentCategory } from '@/lib/api/types';

const CATEGORY_LABEL: Record<ConsentCategory, string> = {
  marketing: 'Marketing',
  analytics: 'Analytics',
  personalization: 'Personalization',
  ai_processing: 'AI processing',
};

/** Display-only locale formatting of a bigint count string (never re-divided/summed). */
function fmtCount(s: string): string {
  // The value is a non-negative integer string; BigInt → Number is safe for display
  // at realistic subject counts. We never do arithmetic on it.
  try {
    return BigInt(s).toLocaleString('en-IN');
  } catch {
    return s;
  }
}

export function CoverageCard({
  data,
}: {
  data: Extract<ConsentCoverageResponse, { state: 'has_data' }>;
}) {
  return (
    <Card data-testid="consent-coverage-card">
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">
          Consent coverage by category
        </CardTitle>
      </CardHeader>
      <CardContent>
        <table className="w-full text-sm">
          <caption className="sr-only">
            Consent coverage: granted vs withdrawn subject counts for each of the four
            consent categories.
          </caption>
          <thead>
            <tr className="border-b text-xs uppercase tracking-wide text-muted-foreground">
              <th scope="col" className="py-2 text-left font-medium">
                Category
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck className="h-3.5 w-3.5 text-success" aria-hidden="true" />
                  Granted
                </span>
              </th>
              <th scope="col" className="py-2 text-right font-medium">
                <span className="inline-flex items-center gap-1">
                  <ShieldX className="h-3.5 w-3.5 text-destructive" aria-hidden="true" />
                  Withdrawn
                </span>
              </th>
            </tr>
          </thead>
          <tbody>
            {data.by_category.map((row) => (
              <tr
                key={row.category}
                className="border-b last:border-0"
                data-testid={`consent-coverage-row-${row.category}`}
              >
                <th scope="row" className="py-2 text-left font-normal text-foreground">
                  {CATEGORY_LABEL[row.category]}
                  {row.category === 'marketing' && (
                    <span className="ml-2 rounded bg-muted px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
                      gates sends
                    </span>
                  )}
                </th>
                <td className="py-2 text-right tabular-nums text-foreground">
                  {fmtCount(row.granted)}
                </td>
                <td className="py-2 text-right tabular-nums text-foreground">
                  {fmtCount(row.withdrawn)}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <p className="mt-3 text-xs text-muted-foreground">
          {fmtCount(data.total_subjects)} distinct subjects with a recorded consent state.
          A subject with no recorded grant is suppressed by default (fail-closed).
        </p>
      </CardContent>
    </Card>
  );
}
