'use client';

/**
 * ByoAppSetupPanel — rendered on the Shopify connect tile above the required Client ID / Secret
 * fields. Numbered instructions with copy-buttoned Redirect URL and scope list, so the merchant
 * can configure their Shopify Custom App correctly BEFORE pasting credentials.
 *
 * Copy semantics mirror the existing WebhookSetupPanel (see marketplace-view.tsx CopyRow).
 */

import { useState } from 'react';
import { Copy, Check, Info } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { toast } from '@/components/ui/toaster';
import type { ByoAppSetup } from '@/lib/api/types';

function CopyRow({ tileId, fieldKey, label, value }: { tileId: string; fieldKey: string; label: string; value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      toast({ title: 'Copy failed', description: 'Select the value and copy it manually.', variant: 'destructive' });
    }
  };
  return (
    <div className="space-y-1">
      <Label className="text-[11px] uppercase tracking-wide text-muted-foreground">{label}</Label>
      <div className="flex items-center gap-2">
        <code
          className="min-w-0 flex-1 truncate rounded bg-muted px-2 py-1.5 font-mono text-xs text-foreground"
          data-testid={`byo-${tileId}-${fieldKey}-value`}
          title={value}
        >
          {value}
        </code>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={copy}
          aria-label={`Copy ${label}`}
          data-testid={`byo-${tileId}-${fieldKey}-copy`}
        >
          {copied ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : <Copy className="h-3.5 w-3.5" aria-hidden="true" />}
        </Button>
      </div>
    </div>
  );
}

export function ByoAppSetupPanel({ tileId, displayName, setup }: { tileId: string; displayName: string; setup: ByoAppSetup }) {
  return (
    <div
      className="mb-4 space-y-3 rounded-md border border-primary/30 bg-primary/5 p-4"
      role="region"
      aria-label={`Set up your ${displayName} Custom App`}
      data-testid={`byo-setup-${tileId}`}
    >
      <div className="flex items-start gap-2">
        <Info className="mt-0.5 h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
        <div className="min-w-0">
          <p className="text-sm font-medium text-foreground">Set up your {displayName} Custom App</p>
          <p className="text-xs text-muted-foreground">
            Shopify Custom Apps are per-store — create one on your store, then paste its credentials below.
          </p>
        </div>
      </div>
      <ol className="ml-4 list-decimal space-y-2 text-xs text-muted-foreground">
        <li>In Shopify admin, go to <strong>Settings → Apps and sales channels → Develop apps → Create an app</strong>.</li>
        <li>In the app&apos;s <strong>Configuration</strong> tab, set <strong>Allowed redirection URL(s)</strong> to:</li>
      </ol>
      <CopyRow tileId={tileId} fieldKey="redirect" label="Redirect URL" value={setup.redirect_url} />
      <ol start={3} className="ml-4 list-decimal space-y-2 text-xs text-muted-foreground">
        <li>In <strong>API access scopes</strong>, enable these scopes:</li>
      </ol>
      <CopyRow tileId={tileId} fieldKey="scopes" label="Scopes" value={setup.scopes.join(',')} />
      <ol start={4} className="ml-4 list-decimal space-y-2 text-xs text-muted-foreground">
        <li><strong>Install</strong> the app on your store, then copy the API credentials from the <strong>API credentials</strong> tab into the fields below.</li>
      </ol>
      {setup.docs_url && (
        <p className="text-xs">
          <a href={setup.docs_url} target="_blank" rel="noreferrer" className="text-primary underline">
            Full setup guide →
          </a>
        </p>
      )}
    </div>
  );
}
