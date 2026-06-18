'use client';

/**
 * CapiStatusBadge — the passback / deletion status indicator (Phase 6).
 *
 * A11y (accessibility skill §status-never-colour-only): the verdict is carried by an
 * ICON + a TEXT LABEL, never colour alone. WCAG 1.4.1 — a colourblind/greyscale user
 * still reads the status from the glyph + word. Contrast uses -700 text on a -50 fill
 * (4.5:1+); the neutral statuses use muted foreground on muted fill.
 *
 * Statuses mirror the 0034 CHECK constraints (capi_passback_log + capi_deletion_log):
 *   sent             → a REAL live send to Meta (prod creds only; 0 in dev, never faked)
 *   would_send_dev   → matched & consent-gated, but NOT sent (no live Meta creds — dev)
 *   blocked_no_consent → fail-closed denial (no/withdrawn advertising consent) — SLO=0 proof
 *   deleted          → a passback row superseded by a retroactive deletion
 *   failed           → a real send error (prod only)
 *   requested        → a retroactive deletion was requested (≤15-min path)
 *   would_delete_dev → a deletion matched & queued, but not sent to Meta (dev)
 */

import {
  CheckCircle2,
  XCircle,
  FlaskConical,
  Trash2,
  AlertTriangle,
  Clock,
} from 'lucide-react';
import { cn } from '@/lib/utils';
import type { CapiPassbackStatus, CapiDeletionStatus } from '@/lib/api/types';

type AnyCapiStatus = CapiPassbackStatus | CapiDeletionStatus;

const STATUS_META: Record<
  AnyCapiStatus,
  { label: string; Icon: typeof CheckCircle2; cls: string }
> = {
  sent: {
    label: 'Sent',
    Icon: CheckCircle2,
    cls: 'bg-status-green-50 text-status-green-700 border-current/20',
  },
  would_send_dev: {
    label: 'Would send (dev)',
    Icon: FlaskConical,
    cls: 'bg-status-amber-50 text-status-amber-700 border-current/20',
  },
  blocked_no_consent: {
    label: 'Blocked — no consent',
    Icon: XCircle,
    cls: 'bg-status-red-50 text-status-red-700 border-current/20',
  },
  deleted: {
    label: 'Deleted',
    Icon: Trash2,
    cls: 'bg-muted text-muted-foreground border-current/20',
  },
  failed: {
    label: 'Failed',
    Icon: AlertTriangle,
    cls: 'bg-status-red-50 text-status-red-700 border-current/20',
  },
  requested: {
    label: 'Requested',
    Icon: Clock,
    cls: 'bg-status-amber-50 text-status-amber-700 border-current/20',
  },
  would_delete_dev: {
    label: 'Would delete (dev)',
    Icon: FlaskConical,
    cls: 'bg-status-amber-50 text-status-amber-700 border-current/20',
  },
};

export function CapiStatusBadge({
  status,
  className,
}: {
  status: AnyCapiStatus;
  className?: string;
}) {
  const meta = STATUS_META[status] ?? STATUS_META.failed;
  return (
    <span
      role="status"
      aria-label={`Status: ${meta.label}`}
      className={cn(
        'inline-flex items-center gap-1 rounded-md border px-2 py-0.5 text-xs font-semibold',
        meta.cls,
        className,
      )}
    >
      <meta.Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{meta.label}</span>
    </span>
  );
}
