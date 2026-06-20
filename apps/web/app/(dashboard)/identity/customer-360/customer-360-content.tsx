'use client';

/**
 * Customer360Content — the identity control-plane "Customer 360" surface (P0-C slice 1).
 *
 * BFF-ONLY (I-ST01): reads ONLY GET /api/v1/identity/customer. It NEVER queries the identity
 * graph / Postgres directly. Brand scope is applied server-side from the session (RLS); the
 * client only supplies a brain_id to resolve.
 *
 * PII discipline (I-S02): identifiers are shown by TYPE + TIER + a HASH PREFIX only — raw
 * email/phone never crosses the BFF, so it is never in the DOM.
 *
 * A11y: the lookup form has a labelled input; the result region is aria-live so the outcome is
 * announced; lifecycle/tier are text+icon (never colour-only); request_id surfaces on error.
 */

import * as React from 'react';
import { humanize } from '@/lib/format/humanize';
import {
  UserSearch,
  User,
  Link2,
  GitMerge,
  ShieldCheck,
  ShieldOff,
  CircleSlash,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { EmptyState } from '@/components/ui/empty-state';
import { Trash2, AlertTriangle, Split } from 'lucide-react';
import { useCustomer360, useEraseCustomer, useUnmergeCustomer } from '@/lib/hooks/use-identity';
import type { Customer360Identifier, Customer360Merge } from '@/lib/api/types';

function ConsentBadge({ on, label }: { on: boolean; label: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm">
      {on ? (
        <ShieldCheck className="h-4 w-4 text-emerald-600" aria-hidden="true" />
      ) : (
        <ShieldOff className="h-4 w-4 text-muted-foreground" aria-hidden="true" />
      )}
      <span>
        {label}: <strong>{on ? 'granted' : 'not granted'}</strong>
      </span>
    </span>
  );
}

export function Customer360Content() {
  const [input, setInput] = React.useState('');
  const [submittedId, setSubmittedId] = React.useState('');
  const [confirming, setConfirming] = React.useState(false);
  const { data, isLoading, isFetching, error, refetch } = useCustomer360(submittedId);
  const erase = useEraseCustomer();
  const unmerge = useUnmergeCustomer();

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSubmittedId(input.trim());
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Customer 360</h1>
        <p className="text-sm text-muted-foreground">
          Resolve a customer by their Brain ID to see lifecycle, consent, linked identifiers, and
          merge history. Identifiers are shown hashed — raw PII never leaves the vault.
        </p>
      </div>

      <form onSubmit={onSubmit} className="flex items-end gap-3" role="search">
        <div className="flex-1 max-w-xl">
          <label htmlFor="brain-id" className="mb-1.5 block text-sm font-medium">
            Brain ID
          </label>
          <Input
            id="brain-id"
            name="brain_id"
            placeholder="e.g. 7f3c1e0a-9b2d-4c11-8a55-0b1c2d3e4f50"
            value={input}
            onChange={(e) => setInput(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <Button type="submit" disabled={input.trim().length === 0}>
          <UserSearch className="mr-2 h-4 w-4" aria-hidden="true" />
          Look up
        </Button>
      </form>

      <div aria-live="polite" aria-busy={isLoading || isFetching}>
        {submittedId.length === 0 ? (
          <EmptyState
            icon={<UserSearch className="h-6 w-6" aria-hidden="true" />}
            title="Enter a Brain ID to begin"
            description="Customer 360 resolves the identity graph for the active brand."
          />
        ) : isLoading ? (
          <div className="space-y-3" aria-hidden="true">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-40 w-full" />
          </div>
        ) : error ? (
          <ErrorCard error={error} retry={refetch} />
        ) : !data ? null : data.state === 'not_found' ? (
          <EmptyState
            icon={<CircleSlash className="h-6 w-6" aria-hidden="true" />}
            title="No customer found"
            description={`No customer with Brain ID ${data.brain_id} exists for the active brand.`}
          />
        ) : (
          <div className="space-y-6">
            {/* Profile */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <User className="h-5 w-5" aria-hidden="true" />
                  Profile
                </CardTitle>
              </CardHeader>
              <CardContent className="grid gap-4 sm:grid-cols-2">
                <dl className="space-y-2 text-sm">
                  <div>
                    <dt className="text-muted-foreground">Brain ID</dt>
                    <dd className="font-mono">{data.customer.brain_id}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">Lifecycle</dt>
                    <dd className="font-medium">{humanize(data.customer.lifecycle_state)}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">First seen</dt>
                    <dd>{new Date(data.customer.created_at).toLocaleString()}</dd>
                  </div>
                  {data.customer.merged_into ? (
                    <div>
                      <dt className="text-muted-foreground">Merged into</dt>
                      <dd className="font-mono">{data.customer.merged_into}</dd>
                      <dd className="mt-2">
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={unmerge.isPending}
                          onClick={() => unmerge.mutate(data.customer.brain_id)}
                        >
                          <Split className="mr-2 h-4 w-4" aria-hidden="true" />
                          {unmerge.isPending ? 'Splitting…' : 'Split (unmerge)'}
                        </Button>
                        {unmerge.data?.unmerged ? (
                          <span className="ml-2 text-sm text-emerald-700">Split — re-look-up to refresh.</span>
                        ) : null}
                      </dd>
                    </div>
                  ) : null}
                </dl>
                <div className="space-y-2">
                  <ConsentBadge on={data.customer.resolution_consent} label="Identity resolution" />
                  <ConsentBadge on={data.customer.ai_processing_consent} label="AI processing" />
                </div>
              </CardContent>
            </Card>

            {/* Identifiers */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <Link2 className="h-5 w-5" aria-hidden="true" />
                  Linked identifiers ({data.identifiers.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.identifiers.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No identifiers linked yet.</p>
                ) : (
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="border-b text-left text-muted-foreground">
                        <th scope="col" className="py-2 pr-4 font-medium">Type</th>
                        <th scope="col" className="py-2 pr-4 font-medium">Tier</th>
                        <th scope="col" className="py-2 pr-4 font-medium">Status</th>
                        <th scope="col" className="py-2 pr-4 font-medium">Hash</th>
                        <th scope="col" className="py-2 font-medium">Linked</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.identifiers.map((id: Customer360Identifier, i: number) => (
                        <tr key={`${id.identifier_type}-${id.identifier_hash_prefix}-${i}`} className="border-b last:border-0">
                          <td className="py-2 pr-4">{humanize(id.identifier_type)}</td>
                          <td className="py-2 pr-4">{id.tier}</td>
                          <td className="py-2 pr-4">{id.is_active ? 'active' : 'inactive'}</td>
                          <td className="py-2 pr-4 font-mono text-xs text-muted-foreground">{id.identifier_hash_prefix}…</td>
                          <td className="py-2">{new Date(id.created_at).toLocaleDateString()}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </CardContent>
            </Card>

            {/* Merge history */}
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <GitMerge className="h-5 w-5" aria-hidden="true" />
                  Merge history ({data.merges.length})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {data.merges.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No merges recorded.</p>
                ) : (
                  <ul className="space-y-3">
                    {data.merges.map((m: Customer360Merge) => (
                      <li key={`${m.canonical_brain_id}-${m.merged_brain_id}-${m.committed_at}`} className="text-sm">
                        <div>
                          <span className="font-mono">{m.merged_brain_id}</span>
                          {' → '}
                          <span className="font-mono">{m.canonical_brain_id}</span>
                        </div>
                        <div className="text-muted-foreground">
                          This profile was the <strong>{m.role}</strong> · confidence {m.confidence} ·{' '}
                          {m.rule_version} · {new Date(m.committed_at).toLocaleString()}
                          {m.identifier_combo.length > 0 ? ` · via ${m.identifier_combo.join(', ')}` : ''}
                        </div>
                      </li>
                    ))}
                  </ul>
                )}
              </CardContent>
            </Card>

            {/* Danger zone — DPDP right-to-deletion */}
            {data.customer.lifecycle_state !== 'erased' && (
              <Card className="border-destructive/40">
                <CardHeader>
                  <CardTitle className="flex items-center gap-2 text-destructive">
                    <AlertTriangle className="h-5 w-5" aria-hidden="true" />
                    DPDP erasure
                  </CardTitle>
                </CardHeader>
                <CardContent className="space-y-3">
                  <p className="text-sm text-muted-foreground">
                    Permanently delete this customer&apos;s stored email/phone, deactivate their
                    identifiers, and mark them erased. This cannot be undone.
                  </p>
                  {erase.data?.erased ? (
                    <p className="text-sm font-medium text-emerald-700">
                      Erased — {erase.data.contact_pii_deleted} PII record(s) deleted,{' '}
                      {erase.data.links_tombstoned} identifier(s) deactivated. Re-look-up to refresh.
                    </p>
                  ) : confirming ? (
                    <div className="flex flex-wrap items-center gap-3">
                      <span className="text-sm font-medium">Erase this customer permanently?</span>
                      <Button
                        variant="destructive"
                        disabled={erase.isPending}
                        onClick={() => erase.mutate(data.customer.brain_id)}
                      >
                        {erase.isPending ? 'Erasing…' : 'Confirm erase'}
                      </Button>
                      <Button variant="outline" disabled={erase.isPending} onClick={() => setConfirming(false)}>
                        Cancel
                      </Button>
                    </div>
                  ) : (
                    <Button variant="destructive" onClick={() => setConfirming(true)}>
                      <Trash2 className="mr-2 h-4 w-4" aria-hidden="true" />
                      Erase customer (DPDP)
                    </Button>
                  )}
                  {erase.isError ? (
                    <p className="text-sm text-destructive">Erase failed — please try again.</p>
                  ) : null}
                </CardContent>
              </Card>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
