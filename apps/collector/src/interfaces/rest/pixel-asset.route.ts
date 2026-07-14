// SPEC: A.1.1 (WA-03 pixel build unification)
/**
 * /pixel.js — the served brain.js browser asset (Track B).
 *
 * WA-03: the served asset is a LITERAL BUILD ARTIFACT of @brain/pixel-sdk (the esbuild IIFE
 * bundle of packages/pixel-sdk/src/asset/{entry,runtime,auto-instrument,constants}.ts, imported
 * here as a string — PIXEL_ASSET_JS). The previous hand-maintained IIFE divergence is over; the
 * LAST hand-written IIFE is frozen at tests/fixtures/legacy-pixel-iife.ts and equivalence
 * (public API surface + event set + wire shape) is asserted by
 * tests/pixel-asset-equivalence.wa03.test.ts. Regenerate the artifact with
 * `pnpm --filter @brain/pixel-sdk build:asset`.
 *
 * The asset enforces the same INVARIANTS as before, asserted by tests/pixel-asset.test.ts:
 * shape-(a) emission (ADR-1), ONE event per POST (REC-5), event_id minted once + reused on retry
 * (R4), client-side anon-id + 30-min session (NO Set-Cookie, REC-4), raw-only attribution
 * capture, consent fail-safe-absent (I-ST05), NO raw PII / NO salt on the wire (ADR-2). It
 * carries zero-merchant-code auto-instrumentation (SPA nav, cart-add/remove/update, checkout
 * step, login/signup, clicks, scroll-depth, session start/end, exit-intent, file download,
 * native video/audio, social share) + persisted first-touch attribution, and the identity-bridge
 * identify (client-side SHA-256 email hash — the seam WA-07 extends).
 *
 * The merchant snippet (buildDefaultSnippet, pixelRoutes.ts:136) sets
 *   window.__brain = { install_token, brand_id }
 * BEFORE this asset loads, then `<script src="…/pixel.js" defer>`. The production install path
 * (ScriptTag) instead carries ?t=&b= and the handler PREPENDS the bootstrap (dynamic config
 * injection: ingest base url, consent default, install token — a small templating pass over the
 * built bundle, exactly as before).
 *
 * Served with long cache + a strong validator; versioned at /pixel.v{N}.js. collector_version
 * is stamped into every event's properties for forensic provenance.
 */
import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import { loadCollectorConfig } from '@brain/config';
import { PIXEL_ASSET_JS, PIXEL_ASSET_VERSION } from '@brain/pixel-sdk';
import {
  serializeIdentityBootstrapField,
  type PixelIdentityConfigService,
} from './pixel-identity-config.js';

export const PIXEL_VERSION = PIXEL_ASSET_VERSION;

/** The self-contained brain.js IIFE — the BUILT @brain/pixel-sdk asset (WA-03). */
export const PIXEL_JS = PIXEL_ASSET_JS;

/** UUID guard — only inject query-derived values that are real UUIDs (no JS-injection via the asset). */
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function registerPixelAssetRoute(
  app: FastifyInstance,
  // SPEC A.1.1 + A.1.2 (WA-07/WA-08): optional per-brand identity-config resolver. Absent (tests /
  // Redis-less deploys) OR resolving null (flag OFF / unknown token / any failure) ⇒ NO identity
  // field is injected and the served asset behaves exactly as before WA-07 (fail-closed-to-legacy).
  identityConfig?: PixelIdentityConfigService,
): void {
  const handler = async (
    req: FastifyRequest<{ Querystring: { t?: string; b?: string } }>,
    reply: FastifyReply,
  ): Promise<void> => {
    // Production install path (ScriptTag-injected): the src carries ?t=<install_token>&b=<brand_id>.
    // A ScriptTag cannot set window.__brain first (and document.currentScript is null for async
    // injected scripts), so the collector PREPENDS the bootstrap when valid UUIDs are present.
    // The manual-snippet path sets window.__brain itself → serve the plain asset.
    let body = PIXEL_JS;
    const t = req.query?.t;
    const b = req.query?.b;
    if (t && b && UUID_RE.test(t) && UUID_RE.test(b)) {
      // CRITICAL: also pin ingest_base_url, else pixel.js falls back to location.host (the STOREFRONT)
      // and POSTs events to the store's own domain instead of the collector. Use the origin this asset
      // was loaded from (the public CNAME/tunnel) — proto+host from the forwarding headers — so events
      // post back to us. PIXEL_INGEST_BASE_URL is the fallback.
      const rawHost = String(req.headers['host'] ?? '');
      const proto = String(req.headers['x-forwarded-proto'] ?? '').split(',')[0] || 'https';
      const reqOrigin =
        /^[a-z0-9.-]+(:[0-9]+)?$/i.test(rawHost) && /^https?$/.test(proto) ? `${proto}://${rawHost}` : '';
      const ingest = reqOrigin || loadCollectorConfig().PIXEL_INGEST_BASE_URL || '';
      const ingestField = /^https?:\/\/[a-z0-9.:/-]+$/i.test(ingest) ? `,ingest_base_url:"${ingest}"` : '';
      // Default-granted consent (merchant-accepted, flag-gated): only applied by consent() when no
      // real consent signal (window.__brainConsent / Shopify Customer Privacy) exists. See README/RB-4.
      const consentField = loadCollectorConfig().PIXEL_CONSENT_DEFAULT === 'granted' ? ',consent_default:"granted"' : '';
      // SPEC A.1.1 + A.1.2 (WA-07/WA-08): per-brand identity bootstrap — present ONLY when the
      // pixel.identify flag is ON for this brand AND the install token proves the brand pairing.
      // resolve() never throws (fail-closed-to-legacy → empty field).
      const identityField = serializeIdentityBootstrapField(
        identityConfig ? await identityConfig.resolve(t, b) : null,
      );
      body = `window.__brain={install_token:"${t}",brand_id:"${b}"${ingestField}${consentField}${identityField}};\n${PIXEL_JS}`;
    }
    reply
      .header('Content-Type', 'application/javascript; charset=utf-8')
      .header('Cache-Control', 'public, max-age=300') // 5 min (dev); CDN-overridable in prod
      .header('X-Pixel-Version', PIXEL_VERSION)
      // NEVER Set-Cookie on the ASSET (REC-4) — first-party cookie is set on /collect (the event POST).
      .code(200)
      .send(body);
  };
  app.get('/pixel.js', handler);
  // Versioned alias for cache-busting (/pixel.v0.1.0.js).
  app.get('/pixel.v0.1.0.js', handler);
}
