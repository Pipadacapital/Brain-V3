'use client';

/**
 * GateDecisionBadge — the can_contact() decision indicator (D13).
 *
 * A11y (accessibility skill §status-never-colour-only): the verdict is carried by an
 * ICON + a TEXT LABEL, never colour alone. WCAG 1.4.1 — a colourblind/greyscale user
 * still reads "Blocked" / "Allowed" / "Queued" from the glyph + word. Contrast uses
 * -700 text on a -50 fill (4.5:1+).
 *
 * The three decisions mirror CanContactResult.decision (Track B engine):
 *   allow                  → the send is permitted (consent + window + registries OK)
 *   block                  → fail-closed denial (no/withdrawn consent, unregistered DLT, …)
 *   queue_pending_window   → window-blocked only → queued, flushes at 09:00 IST (never dropped)
 */

import { CheckCircle2, XCircle, Clock } from 'lucide-react';
import { StatusBadge, type StatusTone } from '@/components/ui/status-badge';
import type { ConsentGateDecision } from '@/lib/api/types';

const DECISION_META: Record<
  ConsentGateDecision,
  { label: string; Icon: typeof CheckCircle2; tone: StatusTone }
> = {
  allow: { label: 'Allowed', Icon: CheckCircle2, tone: 'success' },
  block: { label: 'Blocked', Icon: XCircle, tone: 'destructive' },
  queue_pending_window: { label: 'Queued', Icon: Clock, tone: 'warning' },
};

export function GateDecisionBadge({
  decision,
  className,
}: {
  decision: ConsentGateDecision;
  className?: string;
}) {
  const meta = DECISION_META[decision];
  return (
    <StatusBadge
      tone={meta.tone}
      hideDot
      role="status"
      aria-label={`Decision: ${meta.label}`}
      className={className}
    >
      <meta.Icon className="h-3.5 w-3.5" aria-hidden="true" />
      <span>{meta.label}</span>
    </StatusBadge>
  );
}
