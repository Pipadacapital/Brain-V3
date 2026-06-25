'use client';

/**
 * FirstPartyHost — configure a first-party CNAME ingest host for the Brain Pixel.
 *
 * A brand can point a subdomain (e.g. events.brand.com) at the Brain collector via DNS
 * CNAME. When set, the embed snippet serves the SDK AND posts events from that
 * first-party host — surviving ITP / tracking-prevention and most ad-blockers. Reads/
 * writes via the BFF (GET /pixel/installation + PATCH /pixel/ingest-host); the server
 * validates the hostname.
 *
 * Honest states: only shown once a pixel installation exists; inline error from the
 * mutation; clear action to revert to the default host. Never fabricates a value.
 */

import { useEffect, useId, useState } from 'react';
import { Check, X } from 'lucide-react';
import { SectionCard } from '@/components/ui/section-card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Alert } from '@/components/ui/alert';
import { usePixelInstallation, useSetPixelIngestHost } from '@/lib/hooks/use-pixel';

// Bare hostname (mirrors the server's isValidIngestHost) — used only to enable/disable Save.
const HOSTNAME_RE =
  /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function FirstPartyHost() {
  const fieldId = useId();
  const { data: installation } = usePixelInstallation();
  const setHost = useSetPixelIngestHost();
  const current = installation?.custom_ingest_host ?? '';
  const [value, setValue] = useState('');

  // Seed the field from the persisted host once the installation loads / changes.
  useEffect(() => {
    setValue(current);
  }, [current]);

  // Only meaningful once a pixel installation exists.
  if (!installation?.installed) return null;

  const normalized = value.trim().toLowerCase();
  const isValid = normalized === '' || HOSTNAME_RE.test(normalized);
  const dirty = normalized !== (current ?? '').toLowerCase();
  const errorMsg = setHost.error instanceof Error ? setHost.error.message : null;

  return (
    <SectionCard
      title="First-party domain"
      description={
        <>
          Point a subdomain at Brain via a DNS <span className="font-mono">CNAME</span> (e.g.{' '}
          <span className="font-mono">events.yourbrand.com</span>) to serve and collect the pixel from
          your own domain. This survives Safari ITP and most ad-blockers. Leave blank to use the default
          host.
        </>
      }
    >
      <div className="space-y-3">
        <div className="space-y-1.5">
          <Label htmlFor={fieldId}>Ingest host</Label>
          <div className="flex flex-wrap items-center gap-2">
            <Input
              id={fieldId}
              type="text"
              inputMode="url"
              placeholder="events.yourbrand.com"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              invalid={!isValid}
              className="min-w-[14rem] max-w-sm flex-1 font-mono"
            />
            <Button
              size="sm"
              disabled={!isValid || !dirty}
              loading={setHost.isPending}
              onClick={() => setHost.mutate(normalized === '' ? null : normalized)}
            >
              <Check />
              Save
            </Button>
            {current && (
              <Button
                size="sm"
                variant="outline"
                disabled={setHost.isPending}
                onClick={() => {
                  setValue('');
                  setHost.mutate(null);
                }}
              >
                <X />
                Clear
              </Button>
            )}
          </div>
        </div>

        {!isValid && (
          <Alert variant="destructive">
            Enter a bare hostname like <span className="font-mono">events.yourbrand.com</span> (no https://
            or path).
          </Alert>
        )}
        {errorMsg && <Alert variant="destructive">{errorMsg}</Alert>}
        {current && isValid && !dirty && (
          <p className="text-sm text-muted-foreground">
            Active first-party host: <span className="font-mono text-foreground">{current}</span> — the
            embed snippet already points here.
          </p>
        )}
      </div>
    </SectionCard>
  );
}
