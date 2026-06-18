/**
 * normalizeHostPreview — a COSMETIC, client-side mirror of the server-authoritative
 * `normalizeBrandHost` (@brain/pixel-sdk, Track A). It exists for two FE-only purposes:
 *
 *   1. A live "we'll track <host>" preview under the onboarding website field.
 *   2. Deriving a default `target_host` for the Tracking Center "provision" action when a
 *      brand has a `domain` but no `pixel_installation` yet.
 *
 * THE SERVER VALUE WINS. This never overrides what the backend persists to
 * `brand.domain` / `pixel_installation.target_host` — it only shows the user what to
 * expect and seeds the provision call. It deliberately mirrors the server algorithm
 * (trim → prepend https → URL parse → http(s) only → lowercase hostname → strip one
 * leading `www.` → require a dot, reject localhost/bare-IP) so the preview matches the
 * persisted value, but the backend is the single source of truth.
 *
 * Returns the canonical host, or `null` for empty/invalid input (skip-for-now or garbage).
 */
const IPV4 = /^(\d{1,3}\.){3}\d{1,3}$/;
/** Matches a leading URI scheme like `http:`, `ftp:`, `mailto:`, `javascript:`. */
const SCHEME_PREFIX = /^[a-z][a-z0-9+.-]*:/i;

export function normalizeHostPreview(raw: string | null | undefined): string | null {
  if (raw == null) return null;
  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // If the input already carries a scheme (with or without `//`), reject anything that
  // isn't http(s) BEFORE prepending — otherwise `mailto:a@b.com` would get `https://`
  // glued on and parse to a bogus host. A bare host (no scheme) gets https:// prepended.
  const hasScheme = SCHEME_PREFIX.test(trimmed);
  if (hasScheme && !/^https?:\/\//i.test(trimmed)) return null;

  const withScheme = hasScheme ? trimmed : `https://${trimmed}`;

  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    return null;
  }

  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;

  let host = url.hostname.toLowerCase().replace(/^www\./, '');

  if (host === '' || !host.includes('.')) return null;
  if (host === 'localhost') return null;
  if (IPV4.test(host)) return null;
  if (host.length > 253) return null;

  return host;
}
