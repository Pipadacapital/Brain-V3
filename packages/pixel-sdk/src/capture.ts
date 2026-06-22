/**
 * pixel-sdk/capture — assemble shape-(a) events (ADR-1) + the public Pixel API.
 *
 * Emits event_name ∈ {page.viewed, cart.item_added, cart.viewed}, ISO occurred_at, a
 * properties bag with install_token / brain_anon_id / session_id / click-ids / utm /
 * referrer / landing / device, and a top-level consent_flags (capture-only, fail-safe-absent).
 *
 * event_id is minted ONCE here per logical event and handed to Transport, which reuses it
 * on every retry (R4). NO PII, NO salt on the wire (ADR-2).
 */
import type {
  BrowserEnv,
  CollectorEventV1,
  EventProperties,
} from './types.js';
import { getOrCreateAnonId, getOrRollSession } from './identity.js';
import { captureClickIds, captureUtm } from './attribution.js';
import { resolveConsent, defaultConsentReader, type ConsentReader } from './consent.js';
import { Transport } from './transport.js';

// DB-AUDIT M2: checkout.started completes the behavioral funnel (sessions→product→cart→CHECKOUT→
// purchased). Fired on the storefront checkout page (Web Pixel / checkout integration); flows as a
// normal session touch into silver_touchpoint, so the funnel gains a real checkout stage.
export type EventName = 'page.viewed' | 'cart.item_added' | 'cart.viewed' | 'checkout.started';

export interface PixelOptions {
  /** Override the CMP reader (default reads window.__brainConsent). */
  consentReader?: ConsentReader;
  /** Override the /collect URL (default: `${ingest_base_url|scriptOrigin}/collect`). */
  collectUrl?: string;
  /** Provider of window.__brainConsent (injected so the core stays env-agnostic). */
  getWindowConsent?: () => unknown;
}

export interface Pixel {
  /** Emit page.viewed. */
  page(extra?: Record<string, unknown>): Promise<void>;
  /** Emit cart.item_added. */
  cartItemAdded(extra?: Record<string, unknown>): Promise<void>;
  /** Emit cart.viewed. */
  cartViewed(extra?: Record<string, unknown>): Promise<void>;
  /** Emit checkout.started (the checkout funnel stage). */
  checkoutStarted(extra?: Record<string, unknown>): Promise<void>;
  /** Emit an arbitrary (bounded) event_name. */
  track(name: EventName, extra?: Record<string, unknown>): Promise<void>;
  /** Re-attempt delivery of any queued events. */
  flush(): Promise<void>;
}

export function createPixel(env: BrowserEnv, options: PixelOptions = {}): Pixel {
  const { install_token, brand_id, ingest_base_url } = env.bootstrap;
  if (!install_token) {
    // Without a token every event would quarantine server-side — fail loud at init.
    throw new Error('[brain.js] window.__brain.install_token is required');
  }
  const ingestBase = (ingest_base_url ?? originOf(env.href())).replace(/\/$/, '');
  const collectUrl = options.collectUrl ?? `${ingestBase}/collect`;
  const transport = new Transport(env, collectUrl);
  const consentReader =
    options.consentReader ?? defaultConsentReader(options.getWindowConsent ?? (() => undefined));

  function buildEvent(name: EventName, extra?: Record<string, unknown>): CollectorEventV1 {
    const anonId = getOrCreateAnonId(env);
    const sessionId = getOrRollSession(env);
    const properties: EventProperties = {
      install_token,
      brain_anon_id: anonId,
      session_id: sessionId,
      referrer: env.referrer() || undefined,
      landing_path: env.pathname(),
      device: { ua_class: env.uaClass(), viewport: env.viewport() },
      ...extra,
    };
    const clickIds = captureClickIds(env);
    if (clickIds) properties.click_ids = clickIds;
    const utm = captureUtm(env);
    if (utm) properties.utm = utm;

    const consent = resolveConsent(consentReader); // undefined → fail-safe-absent

    const event: CollectorEventV1 = {
      schema_version: '1',
      event_id: env.uuid(), // minted ONCE — Transport reuses on retry (R4)
      brand_id, // PARTITIONING ONLY — server derives the authoritative brand from install_token
      correlation_id: env.uuid(),
      event_name: name,
      occurred_at: env.nowIso(),
      properties,
    };
    if (consent) event.consent_flags = consent;
    return event;
  }

  async function emit(name: EventName, extra?: Record<string, unknown>): Promise<void> {
    await transport.enqueue(buildEvent(name, extra));
  }

  return {
    page: (extra) => emit('page.viewed', extra),
    cartItemAdded: (extra) => emit('cart.item_added', extra),
    cartViewed: (extra) => emit('cart.viewed', extra),
    checkoutStarted: (extra) => emit('checkout.started', extra),
    track: (name, extra) => emit(name, extra),
    flush: () => transport.flush(),
  };
}

/** Origin (scheme://host[:port]) of an href, for the default /collect base. */
export function originOf(href: string): string {
  const m = /^([a-z]+:\/\/[^/]+)/i.exec(href);
  return m ? m[1]! : '';
}
