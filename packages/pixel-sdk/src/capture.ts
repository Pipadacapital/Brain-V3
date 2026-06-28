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
import { getOrCreateAnonId, rollSession, endSessionRecord } from './identity.js';
import {
  captureClickIds,
  captureUtm,
  getOrCreateFirstTouch,
  type ClickIdCaptureOptions,
} from './attribution.js';
import { resolveConsent, defaultConsentReader, type ConsentReader } from './consent.js';
import { Transport } from './transport.js';

// DB-AUDIT M2: checkout.started completes the behavioral funnel (sessions→product→cart→CHECKOUT→
// purchased). Fired on the storefront checkout page (Web Pixel / checkout integration); flows as a
// normal session touch into silver_touchpoint, so the funnel gains a real checkout stage.
//
// M14 / H6-behavioral: the funnel was missing the un-do + multi-step + account events. All
// dot.lowercase, all flow as normal session touches into Bronze→silver_touchpoint (the lakehouse
// stream carries these new event_types through staging):
//   - cart.item_removed  (remove_from_cart)  — un-does cart.item_added; abandonment signal
//   - cart.updated       (cart_update)       — quantity/line edits without add/remove
//   - checkout.step_viewed (checkout_steps)  — per-step funnel granularity (step in props)
//   - user.logged_in     (login)             — account page-type / returning-customer signal
//   - user.signed_up     (signup)            — new-account signal
// Behavioural events shared LOCK-STEP with the served pixel (apps/collector pixel-asset.route.ts):
//   - session.started  → once, at the first event of a new 30-min session            → { }
//   - session.ended    → on session expiry (next event after >30min) or pagehide       → { session_duration_ms }
//   - exit_intent      → desktop mouseout leaving through the TOP of the viewport       → { }
//   - download         → click on an <a> whose href ends in a downloadable extension    → { href, file_ext }
//   - video            → native <video>/<audio> play|pause|ended                        → { action, src, position_seconds }
//   - share            → navigator.share() OR a click on a social-share link            → { method }
// (The DOM auto-instrumentation that DETECTS these lives in browser-entry.ts — the env-injected core
//  stays unit-testable; it emits them via track()/the session lifecycle.)
export type EventName =
  | 'page.viewed'
  | 'product.viewed'
  | 'collection.viewed'
  | 'cart.item_added'
  | 'cart.item_removed'
  | 'cart.updated'
  | 'cart.viewed'
  | 'checkout.started'
  | 'checkout.step_viewed'
  | 'user.logged_in'
  | 'user.signed_up'
  | 'session.started'
  | 'session.ended'
  | 'exit_intent'
  | 'download'
  | 'video'
  | 'share';

export interface PixelOptions {
  /** Override the CMP reader (default reads window.__brainConsent). */
  consentReader?: ConsentReader;
  /** Override the /collect URL (default: `${ingest_base_url|scriptOrigin}/collect`). */
  collectUrl?: string;
  /** Provider of window.__brainConsent (injected so the core stays env-agnostic). */
  getWindowConsent?: () => unknown;
  /** Override which click-id URL/cookie keys are captured (keeps click-id capture configurable). */
  clickIds?: ClickIdCaptureOptions;
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
  /** Emit cart.item_removed (remove_from_cart). */
  cartItemRemoved(extra?: Record<string, unknown>): Promise<void>;
  /** Emit cart.updated (cart_update — quantity/line edits). */
  cartUpdated(extra?: Record<string, unknown>): Promise<void>;
  /** Emit checkout.step_viewed (checkout_steps — pass { step } for funnel granularity). */
  checkoutStep(extra?: Record<string, unknown>): Promise<void>;
  /** Emit user.logged_in (login). */
  login(extra?: Record<string, unknown>): Promise<void>;
  /** Emit user.signed_up (signup). */
  signup(extra?: Record<string, unknown>): Promise<void>;
  /** Emit an arbitrary (bounded) event_name. */
  track(name: EventName, extra?: Record<string, unknown>): Promise<void>;
  /** End the active session NOW (pagehide) → emits session.ended { session_duration_ms } if one exists. */
  endSession(): Promise<void>;
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

  // buildEvent takes a RESOLVED sessionId (the session is rolled ONCE per emit, by emit()) so the
  // session.started / session.ended lifecycle events and the triggering event share a coherent view.
  function buildEvent(
    name: EventName,
    extra: Record<string, unknown> | undefined,
    sessionId: string,
  ): CollectorEventV1 {
    const anonId = getOrCreateAnonId(env);
    const properties: EventProperties = {
      install_token,
      brain_anon_id: anonId,
      session_id: sessionId,
      // First-touch snapshot persists past the landing page and rides EVERY event (attribution gap).
      first_touch: getOrCreateFirstTouch(env, options.clickIds),
      referrer: env.referrer() || undefined,
      landing_path: env.pathname(),
      device: { ua_class: env.uaClass(), viewport: env.viewport() },
      ...extra,
    };
    const clickIds = captureClickIds(env, options.clickIds);
    if (clickIds) properties.click_ids = clickIds;
    const utm = captureUtm(env);
    if (utm) properties.utm = utm;

    const consent = resolveConsent(consentReader); // undefined → fail-safe-absent

    const event: CollectorEventV1 = {
      schema_version: '1',
      event_id: env.uuidv7(), // UUIDv7, minted ONCE — Transport reuses on retry (R4)
      brand_id, // PARTITIONING ONLY — server derives the authoritative brand from install_token
      correlation_id: env.uuid(), // correlation_id stays v4
      event_name: name,
      occurred_at: env.nowIso(),
      properties,
    };
    if (consent) event.consent_flags = consent;
    return event;
  }

  async function emit(name: EventName, extra?: Record<string, unknown>): Promise<void> {
    // Roll the session ONCE; emit any lifecycle events around the triggering event (session.ended for
    // an expired session FIRST, then session.started for the fresh one, then the actual event).
    const roll = rollSession(env);
    if (roll.ended) {
      await transport.enqueue(
        buildEvent('session.ended', { session_duration_ms: roll.ended.durationMs }, roll.ended.id),
      );
    }
    if (roll.isNew) {
      await transport.enqueue(buildEvent('session.started', {}, roll.id));
    }
    await transport.enqueue(buildEvent(name, extra, roll.id));
  }

  async function endSession(): Promise<void> {
    const ended = endSessionRecord(env);
    if (ended) {
      await transport.enqueue(
        buildEvent('session.ended', { session_duration_ms: ended.durationMs }, ended.id),
      );
    }
  }

  return {
    page: (extra) => emit('page.viewed', extra),
    cartItemAdded: (extra) => emit('cart.item_added', extra),
    cartViewed: (extra) => emit('cart.viewed', extra),
    checkoutStarted: (extra) => emit('checkout.started', extra),
    cartItemRemoved: (extra) => emit('cart.item_removed', extra),
    cartUpdated: (extra) => emit('cart.updated', extra),
    checkoutStep: (extra) => emit('checkout.step_viewed', extra),
    login: (extra) => emit('user.logged_in', extra),
    signup: (extra) => emit('user.signed_up', extra),
    track: (name, extra) => emit(name, extra),
    endSession: () => endSession(),
    flush: () => transport.flush(),
  };
}

/** Origin (scheme://host[:port]) of an href, for the default /collect base. */
export function originOf(href: string): string {
  const m = /^([a-z]+:\/\/[^/]+)/i.exec(href);
  return m ? m[1]! : '';
}
