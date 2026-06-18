// normalize-host.ts — deterministic, server-authoritative canonical-host derivation.
//
// `normalizeBrandHost` is the SINGLE SOURCE OF TRUTH for turning a user-typed brand
// website into the canonical `target_host` that keys the per-brand pixel_installation
// (ADR-1 of 05-architecture.md). It is a pure function: no I/O, no clock, no randomness.
//
// Contract (the "same site three ways → one host → one token" proof):
//   normalizeBrandHost(x) === normalizeBrandHost(normalizeBrandHost(x)!)   (idempotent)
//   for every input x whose first pass yields a non-null host.
//
// Two outcomes, two meanings:
//   - null from an EMPTY/absent input  → first-class "skip for now" (no error, no provision).
//   - null from a NON-EMPTY input      → validation failure (caller surfaces a 422 / form error).
// The caller distinguishes the two by checking whether the raw input was blank.

const MAX_HOST_LENGTH = 253; // matches brand.domain max(253), contracts brand.api.v1.

/** True if the host is a bare IPv4 (dotted-quad) literal. */
function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((p) => {
    if (!/^\d{1,3}$/.test(p)) return false;
    const n = Number(p);
    return n >= 0 && n <= 255;
  });
}

/**
 * Normalize a user-typed brand website to its canonical registrable host.
 *
 * @param raw the user input (may include scheme, path, query, port, case, www).
 * @returns the canonical lowercase host (punycode for IDN), or null.
 */
export function normalizeBrandHost(raw: string | null | undefined): string | null {
  // 1. Empty / absent → skip-for-now (first-class null, NOT an error).
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // 3-5. Resolve to an http(s) URL. A bare host ("shop.com", "shop.com:8443") has no
  //      `scheme://`, so prepend `https://` and parse that. An input WITH an explicit
  //      scheme must itself be http(s); a non-http(s) scheme (mailto:, ftp:, javascript:,
  //      data:) is rejected — we must NOT silently re-prepend https:// to it (that would
  //      turn `mailto:a@b.com` into a parseable host). The regex detects an explicit
  //      `scheme://` authority form only.
  const hasSchemeAuthority = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed);
  let url: URL;
  if (hasSchemeAuthority) {
    try {
      url = new URL(trimmed);
    } catch {
      return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  } else {
    // No `scheme://`. Reject any other explicit scheme (e.g. `mailto:`, `javascript:`)
    // before we prepend https:// — otherwise the scheme leaks into the parsed host.
    if (/^[a-z][a-z0-9+.-]*:/i.test(trimmed)) {
      // Exception: a leading bare host with a port like `shop.com:8443` is NOT a scheme.
      // A scheme prefix is alphabetic-led with no dot before the colon; a host:port has
      // a dot before the colon. Reject only the scheme-shaped prefix.
      const beforeColon = trimmed.slice(0, trimmed.indexOf(':'));
      if (!beforeColon.includes('.')) return null;
    }
    try {
      url = new URL(`https://${trimmed}`);
    } catch {
      return null;
    }
  }

  // 6-8. hostname drops scheme/path/query/fragment/port/userinfo and returns
  //      punycode (ASCII) for IDN. Lowercase for full determinism.
  let host = url.hostname.toLowerCase();

  // 9. Strip a single leading "www." (ADR-2: canonical host excludes www).
  host = host.replace(/^www\./, '');

  // 10. Must be a real registrable host: non-empty, has a dot, not localhost,
  //     not a bare IP literal.
  if (host === '') return null;
  if (!host.includes('.')) return null;
  if (host === 'localhost') return null;
  if (isIpv4(host)) return null;
  if (host.includes(':')) return null; // bracketed IPv6 → url.hostname keeps colons

  // 11. Length cap (matches brand.domain).
  if (host.length > MAX_HOST_LENGTH) return null;

  return host;
}
