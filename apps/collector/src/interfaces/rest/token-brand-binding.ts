/**
 * token-brand-binding — server-side install_token→brand_id binding on the ingest routes
 * (AUD-INFRA-025, tenant-isolation gap on a public surface).
 *
 * THREAT: brand_id is the TENANT KEY and arrives straight off an unauthenticated public body
 * (accept-before-validate). Without a server-side binding, ANY actor — including one holding a
 * LEAKED install_token for brand A — can POST events tagged brand_id=B and pollute another
 * tenant's Bronze→Silver lane. The pixel SDK has always documented the body brand_id as
 * "PARTITIONING ONLY — server derives the authoritative brand from install_token"
 * (packages/pixel-sdk/src/capture.ts) — this module makes the collector actually hold that line.
 *
 * MECHANISM: the SECURITY DEFINER reader get_pixel_identity_config(install_token, brand_id)
 * (migration 0121) returns a row ONLY when the presented token is registered to the presented
 * brand (pixel.pixel_installation ⋈ tenancy.brand). It is reused here as the binding oracle via
 * the existing BrandConsentConfigReader — NO new SQL surface, no schema change. Verdicts are
 * TTL-cached in a bounded in-process map so the ingest hot path stays off PG.
 *
 * REJECT-BEFORE-SPOOL: this is an ADMISSION GATE (same D-1 argument as the rest of edge-guard),
 * not event validation — it fires only on a PROVEN pairing violation, before the spool INSERT.
 *
 * FAIL-SAFE (no silent event loss — the AUD-INFRA-025 remediation contract):
 *  - Only a body presenting BOTH a well-formed (uuid) install_token AND brand_id whose pairing
 *    the oracle DISPROVES is rejected — and the rejection is LOUD: warn log + counter + a clear
 *    403 TOKEN_BRAND_MISMATCH code. Never a silent drop.
 *  - An incomplete or non-uuid pair ADMITS (the existing accept-before-validate posture; the
 *    downstream Silver quarantine owns unprovable envelopes — R2).
 *  - A reader failure (PG down) ADMITS + warns + counts (fail-open): an infrastructure outage
 *    must not drop events — the durability anchor outranks the origin/tenant filter.
 *  - Mode is env-driven (EDGE_TOKEN_BINDING_MODE): 'enforce' (default) rejects proven mismatches,
 *    'log' observes them without rejecting (instant rollback posture), 'off' is the kill switch.
 */
import { incrementCounter } from '@brain/observability';
import { log } from '../../log.js';
import type { BrandConsentConfigReader } from './pixel-identity-config.js';

/** Enforcement posture (env EDGE_TOKEN_BINDING_MODE). */
export type TokenBindingMode = 'off' | 'log' | 'enforce';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** A fully-presented (install_token, brand_id) pair off one raw ingest body. */
export interface BindingPair {
  installToken: string;
  brandId: string;
}

/**
 * Extract the (install_token, brand_id) pair from a raw ingest body — the shapes the pixel SDK
 * emits: brand_id at the top level, install_token under properties. Returns null unless BOTH are
 * well-formed uuids (an incomplete pair is UNPROVABLE — it admits and quarantines downstream, it
 * is never a rejection basis).
 */
export function extractBindingPair(rawBody: Record<string, unknown>): BindingPair | null {
  const brandId = typeof rawBody['brand_id'] === 'string' ? rawBody['brand_id'] : '';
  const props = (
    typeof rawBody['properties'] === 'object' && rawBody['properties'] !== null && !Array.isArray(rawBody['properties'])
      ? rawBody['properties']
      : {}
  ) as Record<string, unknown>;
  const installToken = typeof props['install_token'] === 'string' ? props['install_token'] : '';
  if (!UUID_RE.test(brandId) || !UUID_RE.test(installToken)) return null;
  return { installToken, brandId };
}

/** Per-pair oracle verdict. 'error' = reader failure (fail-open, admits). */
export type BindingVerdict = 'bound' | 'mismatch' | 'error';

export interface TokenBrandBindingOptions {
  /** The 0121 SECURITY DEFINER oracle (row ⇔ token belongs to brand) — reuses the pixel-identity reader. */
  reader: BrandConsentConfigReader;
  mode: TokenBindingMode;
  /** Verdict cache TTL ms (default 60s — same convergence class as the pixel-identity cache). */
  ttlMs?: number;
  /** Max cached pairs (bounds memory under token-fuzzing floods; default 10k). */
  maxEntries?: number;
  /** Clock injection for tests. */
  now?: () => number;
}

/** The gate's decision over one request's bodies. */
export interface BindingDecision {
  admit: boolean;
  /** Set on a rejection — the offending brand_id (tenant key, a UUID — not PII). */
  brandId?: string;
}

export class TokenBrandBinding {
  private readonly cache = new Map<string, { verdict: BindingVerdict; at: number }>();
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly now: () => number;

  constructor(private readonly opts: TokenBrandBindingOptions) {
    this.ttlMs = opts.ttlMs ?? 60_000;
    this.maxEntries = opts.maxEntries ?? 10_000;
    this.now = opts.now ?? (() => Date.now());
  }

  get mode(): TokenBindingMode {
    return this.opts.mode;
  }

  /** Oracle verdict for one pair, TTL-cached (bounded map, oldest-entry eviction). */
  async verdictFor(pair: BindingPair): Promise<BindingVerdict> {
    const key = `${pair.installToken}:${pair.brandId}`;
    const now = this.now();
    const hit = this.cache.get(key);
    if (hit && now - hit.at < this.ttlMs) return hit.verdict;

    let verdict: BindingVerdict;
    try {
      const row = await this.opts.reader.read(pair.installToken, pair.brandId);
      verdict = row !== null ? 'bound' : 'mismatch';
    } catch (err) {
      // FAIL-OPEN: a PG outage must not drop events. Loud (counted + warned), and the error
      // verdict is cached too so an outage cannot hammer PG from the ingest hot path.
      incrementCounter('collector_edge_token_binding_error_total');
      log.warn('token→brand binding lookup failed — admitting (fail-open, no event loss)', { err });
      verdict = 'error';
    }

    if (!this.cache.has(key) && this.cache.size >= this.maxEntries) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
    this.cache.set(key, { verdict, at: now });
    return verdict;
  }

  /**
   * Admission decision over ONE request's bodies (1 for /collect//v1/events, N for /batch —
   * distinct pairs deduped; a legit batch spans one storefront so this is ~1 oracle call).
   * The whole request rejects on the FIRST proven mismatch (a batch is atomic — it spools
   * entirely or not at all, matching the spool contract).
   */
  async admits(bodies: ReadonlyArray<Record<string, unknown>>): Promise<BindingDecision> {
    if (this.opts.mode === 'off') return { admit: true };

    const seen = new Set<string>();
    for (const body of bodies) {
      const pair = extractBindingPair(body);
      if (!pair) continue; // unprovable pair — existing accept posture (downstream quarantine)
      const key = `${pair.installToken}:${pair.brandId}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const verdict = await this.verdictFor(pair);
      if (verdict !== 'mismatch') continue;

      // PII-safe: brand_id is the uuid tenant key; the install_token is NEVER logged.
      incrementCounter('collector_edge_token_binding_mismatch_total', { mode: this.opts.mode });
      if (this.opts.mode === 'enforce') {
        log.warn('install_token→brand_id binding violation — rejecting (TOKEN_BRAND_MISMATCH)', {
          brand_id: pair.brandId,
        });
        return { admit: false, brandId: pair.brandId };
      }
      log.warn('install_token→brand_id binding violation — ADMITTED (EDGE_TOKEN_BINDING_MODE=log)', {
        brand_id: pair.brandId,
      });
    }
    return { admit: true };
  }
}
