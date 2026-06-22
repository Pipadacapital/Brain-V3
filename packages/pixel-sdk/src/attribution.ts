/**
 * pixel-sdk/attribution — RAW-ONLY click-id + UTM + referrer/landing capture (RO1).
 *
 * These are opaque attribution signals modeled downstream. NO PII, NO salt (ADR-2).
 */
import type { BrowserEnv, ClickIds, Utm } from './types.js';

/** Parse the query string from a URL href into a flat map. */
export function parseQuery(href: string): Record<string, string> {
  const out: Record<string, string> = {};
  const qIndex = href.indexOf('?');
  if (qIndex < 0) return out;
  const hashIndex = href.indexOf('#');
  const query = href.slice(qIndex + 1, hashIndex < 0 ? undefined : hashIndex);
  for (const pair of query.split('&')) {
    if (!pair) continue;
    const eq = pair.indexOf('=');
    const key = eq < 0 ? pair : pair.slice(0, eq);
    const val = eq < 0 ? '' : pair.slice(eq + 1);
    try {
      out[decodeURIComponent(key)] = decodeURIComponent(val);
    } catch {
      out[key] = val;
    }
  }
  return out;
}

// Acquisition click-ids captured at the edge. Capturing here is irreversible-if-missed: a click-id
// not read off the landing URL is lost forever. msclkid (Bing), gbraid/wbraid (Google iOS app↔web),
// dclid (Google Display) were missing → that paid traffic was misclassified as `direct`.
// These ride the LANDING URL query string.
export const CLICK_ID_URL_KEYS = [
  'fbclid',
  'gclid',
  'ttclid',
  'msclkid',
  'gbraid',
  'wbraid',
  'dclid',
] as const;

// Cookie-resident ad ids set by the platforms' own first-party tags. They persist past the landing
// URL (the click-id only appears on the first hit) so we read them on every event for CAPI match
// quality. `_fbc`/`_fbp` are DISTINCT (a CAPI payload needs both); `li_fat_id` is LinkedIn's, the
// Pinterest cookie is `_epik` (emitted under the `epik` key). [cookieName, clickIdKey].
export const CLICK_ID_COOKIE_KEYS: ReadonlyArray<readonly [string, keyof ClickIds]> = [
  ['_fbc', '_fbc'],
  ['_fbp', '_fbp'],
  ['li_fat_id', 'li_fat_id'],
  ['_epik', 'epik'],
];

const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;

export interface ClickIdCaptureOptions {
  /** Override the URL query keys captured (default CLICK_ID_URL_KEYS). */
  urlKeys?: ReadonlyArray<keyof ClickIds>;
  /** Override the cookie→key pairs captured (default CLICK_ID_COOKIE_KEYS). [] disables cookie capture. */
  cookieKeys?: ReadonlyArray<readonly [string, keyof ClickIds]>;
}

/**
 * Extract click-ids from the current URL query + the platform first-party cookies.
 *
 * URL keys win over cookie keys for the SAME field (the landing URL is the freshest signal). `_fbc`
 * is captured DISTINCT from `fbclid` (NOT conflated) so Meta CAPI gets the formatted cookie verbatim.
 */
export function captureClickIds(
  env: BrowserEnv,
  options: ClickIdCaptureOptions = {},
): ClickIds | undefined {
  const urlKeys = options.urlKeys ?? CLICK_ID_URL_KEYS;
  const cookieKeys = options.cookieKeys ?? CLICK_ID_COOKIE_KEYS;
  const q = parseQuery(env.href());
  const ids: ClickIds = {};
  for (const k of urlKeys) {
    const v = q[k as string];
    if (v) ids[k] = v;
  }
  for (const [cookieName, idKey] of cookieKeys) {
    if (ids[idKey]) continue; // a URL value for this key wins
    const c = env.cookie(cookieName);
    if (c) ids[idKey] = c;
  }
  return Object.keys(ids).length > 0 ? ids : undefined;
}

/** Extract utm_* params from the current URL. */
export function captureUtm(env: BrowserEnv): Utm | undefined {
  const q = parseQuery(env.href());
  const utm: Utm = {};
  for (const k of UTM_KEYS) {
    const v = q[`utm_${k}`];
    if (v) utm[k] = v;
  }
  return Object.keys(utm).length > 0 ? utm : undefined;
}
