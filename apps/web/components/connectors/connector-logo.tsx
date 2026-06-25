'use client';

/**
 * ConnectorLogo — renders a connector's brand mark in the marketplace tile.
 *
 * Logos are static SVG assets under apps/web/public/connectors/<id>.svg. The lookup is by the
 * connector's catalog id (the same id used everywhere else — shopify, meta, ga4, …). A connector
 * without a registered asset falls back to a neutral monogram chip (first letter of the display
 * name) so a new catalog entry NEVER renders a broken image — it degrades gracefully.
 *
 * The asset is wrapped in a square, rounded "app icon" frame with a hairline border so the row of
 * tiles reads as a clean, consistent grid regardless of each logo's intrinsic padding.
 */

import { useState } from 'react';
import { cn } from '@/lib/utils';

/** Connector ids that have a brand SVG under /public/connectors. Keep in sync with the catalog. */
const LOGO_IDS = new Set<string>([
  'shopify',
  'woocommerce',
  'meta',
  'google_ads',
  'ga4',
  'razorpay',
  'gokwik',
  'shopflo',
  'shiprocket',
  'whatsapp',
  'hubspot',
]);

export interface ConnectorLogoProps {
  /** Catalog id (e.g. 'shopify'). Drives the asset lookup. */
  id: string;
  /** Display name — used for the alt text and the monogram fallback. */
  name: string;
  /** Frame size in px (square). Default 40. */
  size?: number;
  className?: string;
}

export function ConnectorLogo({ id, name, size = 40, className }: ConnectorLogoProps) {
  const [failed, setFailed] = useState(false);
  const hasAsset = LOGO_IDS.has(id) && !failed;
  const monogram = (name.trim()[0] ?? '?').toUpperCase();

  return (
    <span
      className={cn(
        'inline-flex shrink-0 items-center justify-center overflow-hidden rounded-lg border border-border bg-card',
        className,
      )}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {hasAsset ? (
        // Intentional static <img> for a public SVG asset (no next/image
        // optimization needed). The original `eslint-disable-next-line
        // @next/next/no-img-element` directive was REMOVED — this repo's flat
        // ESLint config does not load @next/eslint-plugin-next, so naming that
        // rule errored as "rule not found"; with no img-element rule active there
        // is nothing to suppress. This comment documents the deliberate choice.
        <img
          src={`/connectors/${id}.svg`}
          alt=""
          width={size}
          height={size}
          className="h-full w-full object-contain"
          onError={() => setFailed(true)}
          loading="lazy"
          draggable={false}
        />
      ) : (
        <span className="flex h-full w-full items-center justify-center bg-muted text-sm font-semibold text-muted-foreground">
          {monogram}
        </span>
      )}
    </span>
  );
}
