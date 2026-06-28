/**
 * relative-time — turns an endpoint timestamp (generated_at / served_at / as_of /
 * last_refresh, ISO string) into a { label, tone } pair for <FreshnessIndicator>.
 *
 * FreshnessIndicator deliberately does NOT format time — this is the missing piece.
 *
 * Honesty rule (Brain): when the endpoint exposes NO timestamp, the tone is
 * 'unknown' and the label is "an unknown time ago" — we never fabricate a
 * "just now". Only ~10 BFF endpoints expose a freshness timestamp today; every
 * other widget should render tone='unknown' rather than imply it's live.
 *
 * No date-fns dependency in apps/web — small Intl-based helper (en-IN), pure, no React.
 */

import type { FreshnessTone } from '@/components/ui/freshness-indicator';

export type { FreshnessTone };

export interface RelativeTime {
  /** Pre-formatted relative label, e.g. "2 minutes ago". */
  label: string;
  tone: FreshnessTone;
  /** Absolute timestamp for the title attr / screen readers; null when unknown. */
  absolute: string | null;
}

/** Default freshness SLA: data older than this is toned 'stale'. */
const DEFAULT_STALE_AFTER_MS = 60 * 60 * 1000; // 1 hour

/**
 * Convert an ISO timestamp into a relative label + freshness tone.
 *
 * @param iso          The endpoint timestamp (generated_at/served_at/as_of/last_refresh) or null/undefined.
 * @param staleAfterMs Age (ms) beyond which the tone becomes 'stale'. Default 1h.
 */
export function relativeTime(
  iso: string | null | undefined,
  staleAfterMs: number = DEFAULT_STALE_AFTER_MS,
): RelativeTime {
  if (!iso) return { label: 'an unknown time ago', tone: 'unknown', absolute: null };

  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return { label: 'an unknown time ago', tone: 'unknown', absolute: null };

  const diffMs = Date.now() - ts;
  const tone: FreshnessTone = diffMs > staleAfterMs ? 'stale' : 'fresh';
  return { label: formatRelativeLabel(diffMs), tone, absolute: formatAbsolute(ts) };
}

/** "just now" / "3 minutes ago" / "2 hours ago" / "5 days ago". */
function formatRelativeLabel(diffMs: number): string {
  if (diffMs < 0) return 'just now';
  const rtf = new Intl.RelativeTimeFormat('en-IN', { numeric: 'auto' });
  const sec = Math.round(diffMs / 1000);
  const min = Math.round(sec / 60);
  const hr = Math.round(min / 60);
  const day = Math.round(hr / 24);

  if (sec < 45) return 'just now';
  if (min < 60) return rtf.format(-min, 'minute');
  if (hr < 24) return rtf.format(-hr, 'hour');
  if (day < 30) return rtf.format(-day, 'day');
  const month = Math.round(day / 30);
  if (month < 12) return rtf.format(-month, 'month');
  return rtf.format(-Math.round(month / 12), 'year');
}

function formatAbsolute(ts: number): string {
  return new Date(ts).toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
