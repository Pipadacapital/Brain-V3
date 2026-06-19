'use client';

/**
 * PiiVaultContent — the PII vault status surface (identity control-plane, P0-C slice 2).
 *
 * BFF-ONLY (I-ST01): reads ONLY GET /api/v1/identity/vault-coverage — counts only, NEVER
 * raw PII. The vault stores AES-256-GCM ciphertext (per-brand DEK); only the send_service
 * read path decrypts, transiently, at conversion-passback time.
 *
 * A11y: cards have headings; the coverage figure is text (not colour-only); loading uses
 * aria-busy; errors surface the request_id via ErrorCard.
 */

import * as React from 'react';
import { Lock, ShieldCheck, Mail, Phone, Users } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { useVaultCoverage } from '@/lib/hooks/use-identity';

function Stat({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: string | number;
}) {
  return (
    <div className="flex items-center gap-3">
      <div className="text-muted-foreground" aria-hidden="true">
        {icon}
      </div>
      <div>
        <div className="text-2xl font-semibold tabular-nums">{value}</div>
        <div className="text-sm text-muted-foreground">{label}</div>
      </div>
    </div>
  );
}

export function PiiVaultContent() {
  const { data, isLoading, isFetching, error, refetch } = useVaultCoverage();

  return (
    <div className="space-y-6">
      <div>
        <h1 className="flex items-center gap-2 text-2xl font-semibold tracking-tight">
          <Lock className="h-6 w-6" aria-hidden="true" />
          PII Vault
        </h1>
        <p className="text-sm text-muted-foreground">
          Customer email and phone are stored encrypted at rest (AES-256-GCM, per-brand key).
          Raw values never leave the vault — only the conversion-passback path decrypts them
          transiently to compute Meta match hashes.
        </p>
      </div>

      <div aria-live="polite" aria-busy={isLoading || isFetching}>
        {isLoading ? (
          <div className="grid gap-4 sm:grid-cols-2" aria-hidden="true">
            <Skeleton className="h-36 w-full" />
            <Skeleton className="h-36 w-full" />
          </div>
        ) : error ? (
          <ErrorCard error={error} retry={refetch} />
        ) : !data ? null : (
          <div className="grid gap-4 sm:grid-cols-2">
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ShieldCheck className="h-5 w-5" aria-hidden="true" />
                  Coverage
                </CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <div>
                  <div className="text-4xl font-semibold tabular-nums">{data.coverage_pct}%</div>
                  <div className="text-sm text-muted-foreground">
                    of resolved customers have at least one vaulted identifier
                  </div>
                </div>
                <Stat
                  icon={<Users className="h-5 w-5" aria-hidden="true" />}
                  label={`vaulted of ${data.resolved_customers} resolved customers`}
                  value={data.vaulted_customers}
                />
              </CardContent>
            </Card>

            <Card>
              <CardHeader>
                <CardTitle>Vaulted identifiers</CardTitle>
              </CardHeader>
              <CardContent className="space-y-4">
                <Stat icon={<Mail className="h-5 w-5" aria-hidden="true" />} label="emails" value={data.email_count} />
                <Stat icon={<Phone className="h-5 w-5" aria-hidden="true" />} label="phones" value={data.phone_count} />
              </CardContent>
            </Card>
          </div>
        )}
      </div>
    </div>
  );
}
