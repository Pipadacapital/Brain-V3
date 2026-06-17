/**
 * Relative-time + absolute-time formatting for the data-health surface.
 * No date-fns dependency in apps/web — small, locale-aware (en-IN) Intl helpers.
 * Pure functions; no React. Used by data-health-content.tsx.
 */

/** "3 minutes ago" / "2 hours ago" / "5 days ago" — honest, never fabricates. */
export function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Never';
  const ts = new Date(iso).getTime();
  if (Number.isNaN(ts)) return 'Unknown';
  const diffMs = Date.now() - ts;
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

/** Absolute timestamp for the title attr / SR table — '14 Jun 2026, 18:42'. */
export function formatAbsoluteTime(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  return d.toLocaleString('en-IN', {
    day: '2-digit',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
