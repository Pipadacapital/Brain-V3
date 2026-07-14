// SPEC: A.4
/**
 * TouchpointCacheService — the pure processing core of the real-time touchpoint cache (A.4).
 *
 * Two intents, both per-brand gated by the `identity.tp_cache` flag (DEFAULT OFF, §0.5):
 *
 *   handleCollectorEvent  a touchpoint-relevant collector event → resolve its DETERMINISTIC
 *                         brain_id → append `{type, channel, url_path, ts, session_id}` to
 *                         `{brand_id}:tp:{brain_id}` (score = event-ts-ms), cap at 200, 30d TTL.
 *                         Anon-only / unresolvable / non-touchpoint events are skipped.
 *
 *   handleIdentityMerged  on identity.merged.v1 → union the absorbed brain_id's zset into the
 *                         survivor's, then delete the absorbed key (A.4 merge invalidation).
 *
 * CACHE, NOT TRUTH: this method NEVER throws for an operational reason — it returns a typed
 * outcome and the consumer commits the Kafka offset regardless (journey APIs fall back to
 * Iceberg). Genuine programmer errors still surface.
 *
 * The channel derivation + the touchpoint event-type set MIRROR db/iceberg/spark/silver/
 * silver_touchpoint.py so the hot cache and the Iceberg mart label a touchpoint identically.
 */
import type { FlagService } from '@brain/platform-flags';
import { touchpointCacheKey } from '@brain/tenant-context';
import type { IDeterministicBrainIdResolver } from './BrainIdResolver.js';
import type { ITouchpointCacheStore } from './TouchpointCacheStore.js';

/** The A.4 flag gating this whole lane (registry: @brain/platform-flags). */
export const TP_CACHE_FLAG = 'identity.tp_cache' as const;

/**
 * The journey/behavioral event set silver_touchpoint.py admits (TOUCHPOINT_EVENT_TYPES, verbatim).
 * Non-touchpoint events (orders backfill, spend, connector metadata, identity.*) are skipped.
 */
const TOUCHPOINT_EVENT_TYPES: ReadonlySet<string> = new Set([
  'page.viewed', 'product.viewed', 'collection.viewed', 'cart.viewed', 'cart.item_added',
  'cart.item_removed', 'cart.updated', 'search.submitted', 'checkout.started',
  'checkout.step_viewed', 'checkout.shipping_selected', 'payment.initiated', 'payment.succeeded',
  'payment.failed', 'order.placed', 'purchase.completed', 'coupon.applied', 'form.submitted',
  'user.logged_in', 'user.signed_up', 'identify', 'scroll.depth', 'element.clicked',
  'rage.click', 'dead.click',
]);

export interface TouchpointCacheConfig {
  /** Max touchpoints retained per zset (A.4 = 200). */
  maxTouchpoints: number;
  /** Sliding TTL seconds refreshed on every write (A.4 = 30d). */
  ttlSeconds: number;
}

export type CollectorHandleResult =
  | { outcome: 'appended'; brandId: string; brainId: string; key: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'invalid'; reason: string };

export type MergeHandleResult =
  | { outcome: 'merged'; brandId: string; survivorKey: string; absorbedKey: string }
  | { outcome: 'skipped'; reason: string }
  | { outcome: 'invalid'; reason: string };

/** The compact zset member (A.4): fixed key order → deterministic JSON string. */
interface TouchpointMember {
  type: string;
  channel: string;
  url_path: string | null;
  ts: number;
  session_id: string | null;
}

export class TouchpointCacheService {
  constructor(
    private readonly flags: FlagService,
    private readonly resolver: IDeterministicBrainIdResolver,
    private readonly store: ITouchpointCacheStore,
    private readonly config: TouchpointCacheConfig,
  ) {}

  // ── Collector-event → touchpoint append ─────────────────────────────────────
  async handleCollectorEvent(rawValue: Buffer | null): Promise<CollectorHandleResult> {
    if (rawValue == null || rawValue.length === 0) {
      return { outcome: 'invalid', reason: 'null_or_empty_message' };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawValue.toString('utf8')) as Record<string, unknown>;
    } catch {
      return { outcome: 'invalid', reason: 'json_parse_error' };
    }

    const brandId = typeof parsed['brand_id'] === 'string' ? parsed['brand_id'] : null;
    if (!brandId) return { outcome: 'invalid', reason: 'missing_brand_id' };

    // The event kind: event_name (envelope) with schema_name / event_type fallbacks.
    const eventType = firstStr(parsed, ['event_name', 'schema_name', 'event_type']);
    if (!eventType || !TOUCHPOINT_EVENT_TYPES.has(eventType)) {
      return { outcome: 'skipped', reason: 'not_touchpoint_event' };
    }

    // ── Per-brand flag gate (DEFAULT OFF, fail-closed) — CHECKED BEFORE any resolve/write ──
    // FlagService.isFlagEnabled never throws (fail-closed) + is ~10s in-process cached, so the
    // flag-OFF hot path is a cheap cache read + return (the p99 budget's baseline).
    if (!(await this.flags.isFlagEnabled(brandId, TP_CACHE_FLAG))) {
      return { outcome: 'skipped', reason: 'flag_off' };
    }

    // ── Deterministic brain_id (anon-only / ambiguous → null → skip, no write) ──
    const brainId = await this.resolver.resolve(brandId, parsed);
    if (!brainId) return { outcome: 'skipped', reason: 'no_deterministic_brain_id' };

    const ts = extractTsMs(parsed);
    const member: TouchpointMember = {
      type: eventType,
      channel: deriveChannel(parsed),
      url_path: extractUrlPath(parsed),
      ts,
      session_id: extractSessionId(parsed),
    };

    const key = touchpointCacheKey({ brandId, brainId });
    await this.store.appendCapped(
      key,
      { score: ts, member: JSON.stringify(member) },
      this.config.maxTouchpoints,
      this.config.ttlSeconds,
    );
    return { outcome: 'appended', brandId, brainId, key };
  }

  // ── identity.merged.v1 → merge invalidation (union + delete absorbed) ────────
  async handleIdentityMerged(rawValue: Buffer | null): Promise<MergeHandleResult> {
    if (rawValue == null || rawValue.length === 0) {
      return { outcome: 'invalid', reason: 'null_or_empty_message' };
    }
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(rawValue.toString('utf8')) as Record<string, unknown>;
    } catch {
      return { outcome: 'invalid', reason: 'json_parse_error' };
    }

    const brandId = typeof parsed['brand_id'] === 'string' ? parsed['brand_id'] : null;
    const payload = (parsed['payload'] as Record<string, unknown>) ?? parsed;
    const survivor = typeof payload['canonical_brain_id'] === 'string' ? payload['canonical_brain_id'] : null;
    const absorbed = typeof payload['merged_brain_id'] === 'string' ? payload['merged_brain_id'] : null;
    if (!brandId || !survivor || !absorbed) {
      return { outcome: 'invalid', reason: 'missing_brand_or_merge_ids' };
    }
    if (survivor === absorbed) return { outcome: 'skipped', reason: 'survivor_equals_absorbed' };

    if (!(await this.flags.isFlagEnabled(brandId, TP_CACHE_FLAG))) {
      return { outcome: 'skipped', reason: 'flag_off' };
    }

    const survivorKey = touchpointCacheKey({ brandId, brainId: survivor });
    const absorbedKey = touchpointCacheKey({ brandId, brainId: absorbed });
    await this.store.mergeInto(
      survivorKey,
      absorbedKey,
      this.config.maxTouchpoints,
      this.config.ttlSeconds,
    );
    return { outcome: 'merged', brandId, survivorKey, absorbedKey };
  }
}

// ── extraction helpers (mirror silver_touchpoint.py; best-effort, null-safe) ────

function props(parsed: Record<string, unknown>): Record<string, unknown> {
  const payload = (parsed['payload'] as Record<string, unknown>) ?? parsed;
  return (payload['properties'] as Record<string, unknown>) ?? {};
}

function firstStr(obj: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = obj[k];
    if (typeof v === 'string' && v.trim().length > 0) return v;
  }
  return null;
}

/** Event ts in ms: occurred_at (envelope) → properties.ts → now(). */
function extractTsMs(parsed: Record<string, unknown>): number {
  const occurred = typeof parsed['occurred_at'] === 'string' ? parsed['occurred_at'] : null;
  if (occurred) {
    const ms = Date.parse(occurred);
    if (!Number.isNaN(ms)) return ms;
  }
  const p = props(parsed);
  const rawTs = p['ts'] ?? p['timestamp'];
  if (typeof rawTs === 'number' && Number.isFinite(rawTs)) return rawTs;
  if (typeof rawTs === 'string') {
    const ms = Date.parse(rawTs);
    if (!Number.isNaN(ms)) return ms;
  }
  return Date.now();
}

/** properties.session_id (or nested device.session_id), else null. */
function extractSessionId(parsed: Record<string, unknown>): string | null {
  const p = props(parsed);
  const device = (p['device'] as Record<string, unknown>) ?? {};
  return firstStr(p, ['session_id', '$session_id']) ?? firstStr(device, ['session_id']);
}

/** Best-effort page path: explicit path fields, else the pathname of a url field. */
function extractUrlPath(parsed: Record<string, unknown>): string | null {
  const p = props(parsed);
  const explicit = firstStr(p, ['url_path', 'page_path', 'path', 'landing_path']);
  if (explicit) return explicit;
  const url = firstStr(p, ['url', 'page_url', 'href', 'location']);
  if (url) {
    try {
      return new URL(url).pathname;
    } catch {
      return url; // not an absolute URL — keep as-is (already a path).
    }
  }
  return null;
}

/**
 * Deterministic channel ladder — PORT of silver_touchpoint.py's CASE ladder (verbatim order):
 * click-id families → paid utm_medium → email/social/referral utm_medium → referrer → direct.
 */
function deriveChannel(parsed: Record<string, unknown>): string {
  const p = props(parsed);
  const clickIds = (p['click_ids'] as Record<string, unknown>) ?? {};
  const nonEmpty = (v: unknown): boolean => typeof v === 'string' && v.trim().length > 0;

  if (nonEmpty(clickIds['fbclid'])) return 'paid_meta';
  if (
    nonEmpty(clickIds['gclid']) || nonEmpty(clickIds['gbraid']) ||
    nonEmpty(clickIds['wbraid']) || nonEmpty(clickIds['dclid'])
  ) return 'paid_google';
  if (nonEmpty(clickIds['ttclid'])) return 'paid_tiktok';
  if (nonEmpty(clickIds['msclkid'])) return 'paid_bing';

  const utm = (p['utm'] as Record<string, unknown>) ?? {};
  const medium = typeof utm['medium'] === 'string' ? utm['medium'].toLowerCase() : '';
  if (['cpc', 'ppc', 'paid'].includes(medium)) return 'paid';
  if (medium === 'email') return 'email';
  if (['social', 'paid_social'].includes(medium)) return 'organic_social';
  if (medium === 'referral') return 'referral';

  const referrer = firstStr(p, ['referrer']);
  if (referrer) return 'referral';
  return 'direct';
}
