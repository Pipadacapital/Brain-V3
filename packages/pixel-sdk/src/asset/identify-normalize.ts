// SPEC: A.1.1 (WA-07 pixel.identify.v1)
/**
 * pixel-sdk/asset/identify-normalize — BROWSER-side identifier normalization for the WA-07
 * pixel.identify.v1 envelope (client-side hashing, INTEROP plain-sha256 space per AMD-01).
 *
 * EMAIL — byte-for-byte the @brain/identity-normalization semantics (strip the EXPLICIT shared
 * edge-whitespace set → lowercase → NFC; empty → null; Gmail dots/plus-tags NOT stripped per
 * ADR-normalization-gmail.md). String.prototype.normalize('NFC') is ES2015 — present in every
 * browser the pixel targets (the asset builds at es2017); if it is somehow absent the value is
 * used un-NFC'd (documented drift, healed by the server-side re-validation below).
 *
 * PHONE — a MINIMAL E.164 normalizer for the brand's default country (injected via the pixel
 * bootstrap config; IN + GCC calling codes). libphonenumber is deliberately NOT shipped to the
 * browser (its metadata is ~10× the whole pixel). REDUCED FIDELITY is accepted and documented:
 * this normalizer handles the '+'-international, '00'-international and national-with-trunk-0
 * shapes with ITU length sanity only — it does NOT validate national numbering plans the way
 * libphonenumber `isValid()` does, so a small set of malformed numbers may hash client-side that
 * the server would reject. COMPENSATING CONTROL: Silver-side identity consumption re-validates
 * phone identifiers with full libphonenumber/phonenumbers semantics (packages/
 * identity-normalization + its Python twin db/iceberg/spark/_identity_normalization.py), so a
 * browser-accepted-but-invalid number never becomes a stitch key — the browser hash simply never
 * matches a server-side hash and dies as an unmatched identifier.
 *
 * Style note: same deliberately ES5-ish, fence-everything posture as runtime.ts (this module is
 * bundled into the served asset). Do not "modernize".
 */

/** The explicit shared edge-whitespace class — MUST stay in lockstep with
 *  packages/identity-normalization (EDGE_WS_CLASS) and its Python twin. */
var EDGE_WS_CLASS =
  '\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff';
var EDGE_WS_RE = new RegExp('^[' + EDGE_WS_CLASS + ']+|[' + EDGE_WS_CLASS + ']+$', 'g');

/** Strip the shared explicit edge-whitespace set (NOT String.trim — twin-parity). */
export function stripEdgeWhitespaceBrowser(value: string): string {
  return ('' + value).replace(EDGE_WS_RE, '');
}

/**
 * Email: strip edge whitespace → lowercase → NFC. Empty → null (no identifier).
 * Mirrors @brain/identity-normalization normalizeEmail exactly (parity-tested in
 * identify-normalize.a11.test.ts against the server package).
 */
export function normalizeEmailBrowser(raw: unknown): string | null {
  if (raw == null || typeof raw !== 'string') return null;
  var s = stripEdgeWhitespaceBrowser(raw).toLowerCase();
  try { if (typeof s.normalize === 'function') s = s.normalize('NFC'); } catch (e) { /* use un-NFC'd */ }
  if (s.length === 0) return null;
  // Minimal shape guard (matches the legacy identify's indexOf('@')>0 posture): an "email" without
  // a local part + domain would only pollute the interop hash space.
  var at = s.indexOf('@');
  if (at <= 0 || at === s.length - 1) return null;
  return s;
}

/** Brand default-country calling codes (IN + GCC — BRAND_DEFAULT_COUNTRIES of the server package). */
export var PHONE_COUNTRY_CC: Record<string, string> = {
  IN: '91', AE: '971', SA: '966', QA: '974', BH: '973', KW: '965', OM: '968',
};

/**
 * Phone: MINIMAL E.164 for the brand default country. Returns '+<digits>' or null.
 *
 *   '+<cc><nsn>'                → used as-is (international overrides the default country)
 *   '00<cc><nsn>'               → '00' international prefix → '+<rest>'
 *   national (with/without '0') → strip trunk zeros, prepend the default country's calling code
 *
 * Separators space ( ) - . are tolerated; ANY other character (letters etc.) → null. Length
 * sanity: E.164 total 8–15 digits (ITU E.164), national significant part 6–12 digits. See the
 * module header for the documented fidelity gap vs libphonenumber + the Silver compensating control.
 */
export function normalizePhoneBrowser(raw: unknown, defaultCountry: string): string | null {
  if (raw == null || typeof raw !== 'string') return null;
  var s = stripEdgeWhitespaceBrowser(raw);
  if (s.length === 0) return null;
  // Tolerated separator set only — anything else means "not a phone number".
  if (!/^\+?[0-9 ().-]+$/.test(s)) return null;
  var plus = s.charAt(0) === '+';
  var digits = s.replace(/[^0-9]/g, '');
  if (digits.length === 0) return null;
  var e164: string;
  if (plus) {
    e164 = digits;                       // '+' international — cc already present
  } else if (digits.slice(0, 2) === '00') {
    e164 = digits.slice(2);              // '00' international prefix
    if (e164.length === 0) return null;
  } else {
    var cc = PHONE_COUNTRY_CC[('' + (defaultCountry || 'IN')).toUpperCase()] || PHONE_COUNTRY_CC['IN']!;
    var national = digits.replace(/^0+/, ''); // strip national trunk zero(s)
    if (national.length < 6 || national.length > 12) return null;
    e164 = cc + national;
  }
  if (e164.length < 8 || e164.length > 15) return null; // ITU E.164 bounds
  if (e164.charAt(0) === '0') return null;              // a calling code never starts with 0
  return '+' + e164;
}
