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
const CLICK_ID_KEYS = ['fbclid', 'gclid', 'ttclid', 'msclkid', 'gbraid', 'wbraid', 'dclid'] as const;
const UTM_KEYS = ['source', 'medium', 'campaign', 'term', 'content'] as const;

/** Extract click-ids from the current URL + the _fbc cookie fallback. */
export function captureClickIds(env: BrowserEnv): ClickIds | undefined {
  const q = parseQuery(env.href());
  const ids: ClickIds = {};
  for (const k of CLICK_ID_KEYS) {
    if (q[k]) ids[k] = q[k];
  }
  // _fbc cookie carries the Facebook click-id when fbclid is not on the URL.
  if (!ids.fbclid) {
    const fbc = env.cookie('_fbc');
    if (fbc) ids.fbclid = fbc;
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
