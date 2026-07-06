// SPEC: A.1.1 + A.1.2 (WA-07/WA-08 — pixel identity bootstrap config)
/**
 * pixel-identity-config — resolves the per-brand identity-capture bootstrap the /pixel.js
 * templating pass injects as `window.__brain.identity` (the pixel reads its config from the
 * bootstrap payload — A.1.2).
 *
 * Sources (both per-brand, brand_id-first):
 *   • platform flags `pixel.identify` + `pixel.autodetect.enabled` (@brain/platform-flags —
 *     Redis, DEFAULT OFF, fail-closed);
 *   • tenancy.brand consent config {identity_capture, consent_source} + region_code, read via the
 *     SECURITY DEFINER get_pixel_identity_config(install_token, brand_id) (migration 0121): the
 *     asset request is pre-auth/pre-brand-context, and the install token IS the authorization —
 *     the function returns a row ONLY when the presented token belongs to the presented brand.
 *
 * FAIL-CLOSED-TO-LEGACY (§0.5): flag OFF, unknown token/brand mismatch, Redis or PG down, or any
 * other error ⇒ resolve() returns null ⇒ the served asset carries NO identity field ⇒ the pixel
 * behaves byte-for-byte as before WA-07. A short in-process TTL cache keeps the asset route off
 * PG/Redis per request (the asset itself is also HTTP-cached for 5 min).
 */
import { Pool } from 'pg';
import type { FlagService } from '@brain/platform-flags';

/** The injected `window.__brain.identity` value (mirrors pixel-sdk BrainIdentityBootstrap). */
export interface PixelIdentityBootstrap {
  enabled: true;
  capture: 'off' | 'explicit_only' | 'autodetect';
  consent_source: 'cmp_signal' | 'assume_granted';
  autodetect: boolean;
  phone_country: string;
}

/** Row shape of get_pixel_identity_config (null when the token does not belong to the brand). */
export interface BrandConsentConfigRow {
  identity_capture: string;
  consent_source: string;
  region_code: string;
}

export interface BrandConsentConfigReader {
  read(installToken: string, brandId: string): Promise<BrandConsentConfigRow | null>;
}

/** PG adapter — dedicated tiny pool (the spool pool stays untouched; this path is cache-shielded). */
export class PgBrandConsentConfigReader implements BrandConsentConfigReader {
  private readonly pool: Pool;

  constructor(databaseUrl: string) {
    this.pool = new Pool({ connectionString: databaseUrl, max: 2 });
  }

  async read(installToken: string, brandId: string): Promise<BrandConsentConfigRow | null> {
    const res = await this.pool.query<BrandConsentConfigRow>(
      'SELECT identity_capture, consent_source, region_code FROM get_pixel_identity_config($1::uuid, $2::uuid)',
      [installToken, brandId],
    );
    return res.rows[0] ?? null;
  }

  async end(): Promise<void> {
    await this.pool.end();
  }
}

const CAPTURES = new Set(['off', 'explicit_only', 'autodetect']);
const CONSENT_SOURCES = new Set(['cmp_signal', 'assume_granted']);
const REGION_RE = /^[A-Z]{2}$/;

export interface PixelIdentityConfigService {
  /** null ⇒ inject nothing (legacy asset). Never throws (fail-closed-to-legacy). */
  resolve(installToken: string, brandId: string): Promise<PixelIdentityBootstrap | null>;
}

export interface CreatePixelIdentityConfigServiceOptions {
  reader: BrandConsentConfigReader;
  flags: FlagService;
  /** Cache TTL ms (default 60s — same convergence class as the flag service's local cache). */
  ttlMs?: number;
  /** Non-fatal error sink (a resolve failure only means "serve the legacy asset"). */
  onError?: (err: unknown) => void;
}

export function createPixelIdentityConfigService(
  opts: CreatePixelIdentityConfigServiceOptions,
): PixelIdentityConfigService {
  const ttlMs = opts.ttlMs ?? 60_000;
  const cache = new Map<string, { value: PixelIdentityBootstrap | null; at: number }>();

  async function resolveUncached(
    installToken: string,
    brandId: string,
  ): Promise<PixelIdentityBootstrap | null> {
    // Per-brand master flag first (DEFAULT OFF → the whole v2 identity system stays dark).
    const identifyOn = await opts.flags.isFlagEnabled(brandId, 'pixel.identify');
    if (!identifyOn) return null;

    const row = await opts.reader.read(installToken, brandId);
    if (!row) return null; // token↛brand (or brand gone) — never inject config on an unproven pairing

    // Whitelist-validate everything that reaches the templated JS (no injection surface: the
    // emitted values are enum members / a 2-letter region only).
    const capture = CAPTURES.has(row.identity_capture)
      ? (row.identity_capture as PixelIdentityBootstrap['capture'])
      : 'off';
    const consentSource = CONSENT_SOURCES.has(row.consent_source)
      ? (row.consent_source as PixelIdentityBootstrap['consent_source'])
      : 'cmp_signal';
    const region = REGION_RE.test(row.region_code ?? '') ? row.region_code : 'IN';

    const autodetectOn =
      capture === 'autodetect'
        ? await opts.flags.isFlagEnabled(brandId, 'pixel.autodetect.enabled')
        : false;

    return {
      enabled: true,
      capture,
      consent_source: consentSource,
      autodetect: autodetectOn,
      phone_country: region,
    };
  }

  return {
    async resolve(installToken, brandId): Promise<PixelIdentityBootstrap | null> {
      const key = `${brandId}:${installToken}`;
      const hit = cache.get(key);
      const now = Date.now();
      if (hit && now - hit.at < ttlMs) return hit.value;
      try {
        const value = await resolveUncached(installToken, brandId);
        cache.set(key, { value, at: now });
        return value;
      } catch (err) {
        opts.onError?.(err);
        // FAIL-CLOSED-TO-LEGACY — and cache the miss so an outage cannot hammer PG/Redis.
        cache.set(key, { value: null, at: now });
        return null;
      }
    },
  };
}

/**
 * Serialize the bootstrap for the templating pass. Inputs are whitelist-validated above, so this
 * is a plain JSON.stringify of enum/boolean/2-letter values (matches the existing quoted-field style).
 */
export function serializeIdentityBootstrapField(idc: PixelIdentityBootstrap | null): string {
  if (!idc) return '';
  return `,identity:${JSON.stringify(idc)}`;
}
