'use client';

/**
 * FirstPartyHost — configure a first-party CNAME ingest host for the Brain Pixel (Phase H).
 *
 * A brand can point a subdomain (e.g. events.brand.com) at the Brain collector via DNS CNAME. When
 * set, the embed snippet serves the SDK AND posts events from that first-party host — surviving ITP /
 * tracking-prevention and most ad-blockers that block third-party requests. Reads/writes via the BFF
 * (GET /pixel/installation + PATCH /pixel/ingest-host); the server validates the hostname.
 *
 * Honest states: only shown once a pixel installation exists; inline error from the mutation; clear
 * action to revert to the default host. Never fabricates a value.
 */

import { useEffect, useState } from 'react';
import { Globe, Check, X } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { usePixelInstallation, useSetPixelIngestHost } from '@/lib/hooks/use-pixel';

// Bare hostname (mirrors the server's isValidIngestHost) — used only to enable/disable Save.
const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;

export function FirstPartyHost() {
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
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-1.5">
          <Globe className="h-4 w-4" aria-hidden="true" />
          First-party domain (advanced)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Point a subdomain at Brain via a DNS <span className="font-mono">CNAME</span> (e.g.{' '}
          <span className="font-mono">events.yourbrand.com</span>) to serve and collect the pixel from your
          own domain. This survives Safari ITP and most ad-blockers. Leave blank to use the default host.
        </p>

        <div className="flex flex-wrap items-center gap-2">
          <input
            type="text"
            inputMode="url"
            placeholder="events.yourbrand.com"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            aria-label="First-party ingest host"
            aria-invalid={!isValid}
            className="flex-1 min-w-[14rem] rounded-md border border-border bg-background px-3 py-1.5 text-sm font-mono focus:outline-none focus:ring-2 focus:ring-ring"
          />
          <Button
            size="sm"
            disabled={!isValid || !dirty || setHost.isPending}
            onClick={() => setHost.mutate(normalized === '' ? null : normalized)}
          >
            <Check className="mr-1.5 h-4 w-4" aria-hidden="true" />
            {setHost.isPending ? 'Saving…' : 'Save'}
          </Button>
          {current && (
            <Button
              size="sm"
              variant="outline"
              disabled={setHost.isPending}
              onClick={() => { setValue(''); setHost.mutate(null); }}
            >
              <X className="mr-1.5 h-4 w-4" aria-hidden="true" />
              Clear
            </Button>
          )}
        </div>

        {!isValid && (
          <p className="text-sm text-destructive" role="alert">
            Enter a bare hostname like <span className="font-mono">events.yourbrand.com</span> (no https:// or path).
          </p>
        )}
        {errorMsg && (
          <p className="text-sm text-destructive" role="alert">{errorMsg}</p>
        )}
        {current && isValid && !dirty && (
          <p className="text-sm text-muted-foreground">
            Active first-party host: <span className="font-mono text-foreground">{current}</span> — the
            embed snippet above already points here.
          </p>
        )}
      </CardContent>
    </Card>
  );
}
