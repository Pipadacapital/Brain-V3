'use client';

/**
 * BackfillControl — C1 (feat-connector-backfill)
 *
 * Renders the "Import History" backfill trigger + live progress UX for a connected
 * Shopify connector tile / connector detail.
 *
 * Authz (D-15):
 *   - brand_admin+: trigger button is enabled.
 *   - manager/analyst: trigger button is hidden (not just disabled) — mirrors the
 *     server 403 that would fire anyway. The progress widget is always visible so
 *     managers can see an in-progress backfill started by an admin.
 *
 * D-8 honesty: when estimated_total===null, NEVER render "0%" or a fabricated number.
 *   Show the "Collecting your data…" indeterminate state instead.
 *
 * Progress states:
 *   idle      → trigger button (brand_admin only)
 *   queued    → "Queued…" spinner (indeterminate)
 *   running   → progress bar (percent if estimated_total present, else indeterminate)
 *               records_processed / estimated_total  (or "Collecting your data…")
 *               cursor_date "Data back to <date>"
 *   completed → count + achieved_depth_label
 *   partial   → count + failure_reason + retry button
 *   failed    → failure_reason + retry button
 *
 * Error states:
 *   RECONNECT_REQUIRED      → alert with data-testid backfill-reconnect-required
 *   BACKFILL_ALREADY_RUNNING → alert (already handled by server enforcing overlap lock)
 *   403                     → button hidden (no alert; role constraint is expected)
 *
 * A11y:
 *   - Progress bar has role="progressbar" + aria-valuenow/aria-valuemin/aria-valuemax.
 *   - Status never colour-only: icon + label on every terminal state.
 *   - All interactive elements keyboard-reachable with visible focus ring.
 *   - Error and status messages have aria-live regions.
 *
 * data-testids (from the task brief):
 *   backfill-trigger, backfill-progress, backfill-records, backfill-estimated,
 *   backfill-depth-label, backfill-status, backfill-reconnect-required.
 */

import { useState } from 'react';
import {
  CheckCircle,
  AlertTriangle,
  XCircle,
  Loader2,
  Download,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { ErrorCard } from '@/components/ui/error-card';
import { Badge } from '@/components/ui/badge';
import { useBackfillProgress, useTriggerBackfill } from '@/lib/hooks/use-backfill';
import { useSessionRole } from '@/lib/hooks/use-session-role';
import { BffApiError } from '@/lib/api/client';
import { cn } from '@/lib/utils';
import type { BackfillJobProgress } from '@brain/contracts';

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string | null): string {
  if (!iso) return '';
  return new Date(iso).toLocaleDateString('en-IN', { dateStyle: 'medium' });
}

function formatCount(n: number): string {
  return new Intl.NumberFormat('en-IN').format(n);
}

// ── Sub-components ────────────────────────────────────────────────────────────

/**
 * ProgressBar — deterministic or indeterminate.
 * When percent===null, shows a pulsing indeterminate bar (no fabricated %).
 * D-8: NEVER renders "0%" when estimated_total is null.
 */
function ProgressBar({ percent }: { percent: number | null }) {
  const isDeterminate = percent !== null;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={isDeterminate ? percent : undefined}
      aria-valuetext={isDeterminate ? `${percent}%` : 'Collecting your data…'}
      aria-label="Backfill progress"
      className="relative h-2 w-full overflow-hidden rounded-full bg-muted"
    >
      <div
        className={cn(
          'absolute left-0 top-0 h-full rounded-full transition-all',
          isDeterminate
            ? 'bg-primary'
            : 'animate-pulse bg-primary/60 w-full',
        )}
        style={isDeterminate ? { width: `${percent}%` } : undefined}
      />
    </div>
  );
}

/**
 * BackfillStatusBadge — status with icon + label, never colour-only (a11y).
 */
function BackfillStatusBadge({
  status,
}: {
  status: BackfillJobProgress['status'];
}) {
  const CONFIG = {
    queued: {
      icon: Loader2,
      label: 'Queued',
      cls: 'bg-muted text-muted-foreground',
      spin: true,
    },
    running: {
      icon: Loader2,
      label: 'Importing',
      cls: 'bg-blue-50 text-blue-700',
      spin: true,
    },
    completed: {
      icon: CheckCircle,
      label: 'Completed',
      cls: 'bg-status-green-50 text-status-green-700',
      spin: false,
    },
    partial: {
      icon: AlertTriangle,
      label: 'Partial',
      cls: 'bg-status-amber-50 text-status-amber-700',
      spin: false,
    },
    failed: {
      icon: XCircle,
      label: 'Failed',
      cls: 'bg-status-red-50 text-status-red-700',
      spin: false,
    },
  } as const;

  const cfg = CONFIG[status];
  const Icon = cfg.icon;

  return (
    <span
      data-testid="backfill-status"
      role="status"
      aria-label={`Backfill ${cfg.label}`}
      className={cn(
        'inline-flex items-center gap-1.5 rounded-full px-2.5 py-0.5 text-xs font-semibold',
        cfg.cls,
      )}
    >
      <Icon
        className={cn('h-3.5 w-3.5', cfg.spin && 'animate-spin')}
        aria-hidden="true"
      />
      {cfg.label}
    </span>
  );
}

/**
 * ActiveProgress — renders progress details when status is queued or running.
 */
function ActiveProgress({ job }: { job: BackfillJobProgress }) {
  const hasEstimate = job.estimated_total !== null && job.estimated_total > 0;

  return (
    <div data-testid="backfill-progress" className="space-y-2 mt-2" aria-live="polite">
      <ProgressBar percent={job.percent} />

      <div className="flex items-center justify-between text-xs text-muted-foreground">
        {/* D-8: Only show count / estimate when we have a real denominator. */}
        {hasEstimate ? (
          <span>
            <span data-testid="backfill-records" className="font-medium text-foreground">
              {formatCount(job.records_processed)}
            </span>
            {' / '}
            <span data-testid="backfill-estimated">
              {formatCount(job.estimated_total!)} orders
            </span>
            {job.percent !== null && (
              <span className="ml-1">({job.percent}%)</span>
            )}
          </span>
        ) : (
          /* estimated_total===null → indeterminate: "Collecting your data…" */
          <span
            data-testid="backfill-records"
            aria-live="polite"
            className="italic"
          >
            Collecting your data…
          </span>
        )}

        {job.cursor_date && (
          <span>
            Data back to{' '}
            <time dateTime={job.cursor_date}>{formatDate(job.cursor_date)}</time>
          </span>
        )}
      </div>
    </div>
  );
}

/**
 * TerminalState — renders completed / partial / failed with honest counts and labels.
 */
function TerminalState({
  job,
  onRetry,
  isRetrying,
}: {
  job: BackfillJobProgress;
  onRetry: () => void;
  isRetrying: boolean;
}) {
  const isCompleted = job.status === 'completed';
  const isFailed = job.status === 'failed';

  return (
    <div data-testid="backfill-progress" className="space-y-2 mt-2" aria-live="polite">
      <BackfillStatusBadge status={job.status} />

      {/* Records imported */}
      {job.records_processed > 0 && (
        <p className="text-sm text-muted-foreground">
          <span
            data-testid="backfill-records"
            className="font-medium text-foreground"
          >
            {formatCount(job.records_processed)}
          </span>{' '}
          orders imported
          {job.estimated_total !== null && (
            <>
              {' '}(
              <span data-testid="backfill-estimated">
                {formatCount(job.estimated_total)} total
              </span>
              )
            </>
          )}
        </p>
      )}

      {/* Depth label — written at completion (HP-3), null while running */}
      {isCompleted && job.achieved_depth_label && (
        <p
          data-testid="backfill-depth-label"
          className="text-sm text-muted-foreground"
        >
          Imported last{' '}
          <span className="font-medium text-foreground">
            {job.achieved_depth_label}
          </span>
        </p>
      )}

      {/* Partial depth label too */}
      {job.status === 'partial' && job.achieved_depth_label && (
        <p
          data-testid="backfill-depth-label"
          className="text-sm text-muted-foreground"
        >
          Partial import — {job.achieved_depth_label}
        </p>
      )}

      {/* Failure reason for partial + failed */}
      {job.failure_reason && (
        <p className="text-sm text-status-red-700">
          {isFailed ? 'Error: ' : 'Reason: '}
          <span className="font-medium">{job.failure_reason}</span>
        </p>
      )}

      {/* Retry for partial / failed (brand_admin only — handled by caller hiding the button) */}
      {(job.status === 'partial' || job.status === 'failed') && (
        <Button
          size="sm"
          variant="outline"
          onClick={onRetry}
          disabled={isRetrying}
          data-testid="backfill-trigger"
          aria-label="Retry backfill import"
        >
          {isRetrying && (
            <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
          )}
          {isRetrying ? 'Starting…' : 'Retry Import'}
        </Button>
      )}
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────────────

interface BackfillControlProps {
  /** connector_instance UUID — used to poll /connectors/:id/jobs */
  connectorId: string;
  className?: string;
}

/**
 * BackfillControl — the full trigger + progress widget for a connected connector.
 *
 * Mount on the connected Shopify tile in ConnectorCard or a detail view.
 * Handles all states: idle → trigger; queued/running → progress; terminal → result.
 */
export function BackfillControl({ connectorId, className }: BackfillControlProps) {
  const role = useSessionRole();
  const canTrigger = role === 'owner' || role === 'brand_admin';

  // Controlled error state for trigger failures (RECONNECT_REQUIRED, etc.)
  const [triggerError, setTriggerError] = useState<BffApiError | null>(null);

  const { mutate: trigger, isPending: isTriggering } = useTriggerBackfill(connectorId);

  // Fetch existing job — enabled when we have a connectorId.
  // After a successful trigger the query is invalidated so polling begins.
  const {
    data: job,
    isLoading: jobLoading,
    error: jobError,
    refetch: refetchJob,
  } = useBackfillProgress(connectorId);

  // Derived: is there an active in-progress job?
  const hasActiveJob =
    job && (job.status === 'queued' || job.status === 'running');
  const hasTerminalJob =
    job && (job.status === 'completed' || job.status === 'partial' || job.status === 'failed');

  function handleTrigger() {
    setTriggerError(null);
    trigger(undefined, {
      onError: (err) => {
        if (err instanceof BffApiError) {
          setTriggerError(err);
        }
      },
    });
  }

  function handleRetry() {
    setTriggerError(null);
    trigger(undefined, {
      onError: (err) => {
        if (err instanceof BffApiError) {
          setTriggerError(err);
        }
      },
    });
  }

  // If the job fetch is loading and we have no cached data yet — show skeleton.
  if (jobLoading && !job) {
    return (
      <div className={cn('space-y-2', className)}>
        <Skeleton className="h-8 w-32" />
        <Skeleton className="h-2 w-full" />
      </div>
    );
  }

  // Job fetch error (not 404 — 404 means no job yet, which is normal).
  if (jobError instanceof BffApiError && jobError.status !== 404) {
    return (
      <div className={cn(className)}>
        <ErrorCard error={jobError} retry={refetchJob} />
      </div>
    );
  }

  return (
    <div className={cn('space-y-3', className)}>
      {/* ── RECONNECT_REQUIRED alert ──────────────────────────────────────── */}
      {triggerError?.code === 'RECONNECT_REQUIRED' && (
        <div
          data-testid="backfill-reconnect-required"
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-status-amber-300 bg-status-amber-50 p-3 text-sm text-status-amber-700"
        >
          <p className="font-medium flex items-center gap-1.5">
            <AlertTriangle className="h-4 w-4 shrink-0" aria-hidden="true" />
            Shopify connection expired
          </p>
          <p className="mt-1">
            Please reconnect your Shopify store before importing history.
          </p>
        </div>
      )}

      {/* ── BACKFILL_ALREADY_RUNNING alert ───────────────────────────────── */}
      {triggerError?.code === 'BACKFILL_ALREADY_RUNNING' && (
        <div
          role="alert"
          aria-live="assertive"
          className="rounded-md border border-blue-200 bg-blue-50 p-3 text-sm text-blue-700"
        >
          <p className="font-medium flex items-center gap-1.5">
            <Loader2 className="h-4 w-4 shrink-0 animate-spin" aria-hidden="true" />
            Import already running
          </p>
          <p className="mt-1">
            A history import is already in progress for this connector.
          </p>
        </div>
      )}

      {/* ── Other trigger errors ─────────────────────────────────────────── */}
      {triggerError &&
        triggerError.code !== 'RECONNECT_REQUIRED' &&
        triggerError.code !== 'BACKFILL_ALREADY_RUNNING' && (
          <ErrorCard error={triggerError} />
        )}

      {/* ── Active job: queued / running ─────────────────────────────────── */}
      {hasActiveJob && (
        <div>
          <div className="flex items-center gap-2 mb-2">
            <BackfillStatusBadge status={job.status} />
          </div>
          <ActiveProgress job={job} />
        </div>
      )}

      {/* ── Terminal job: completed / partial / failed ───────────────────── */}
      {hasTerminalJob && canTrigger && (
        <TerminalState
          job={job}
          onRetry={handleRetry}
          isRetrying={isTriggering}
        />
      )}

      {/* Terminal job visible to non-admins (read-only) */}
      {hasTerminalJob && !canTrigger && (
        <div data-testid="backfill-progress" className="space-y-2" aria-live="polite">
          <BackfillStatusBadge status={job.status} />
          {job.records_processed > 0 && (
            <p className="text-sm text-muted-foreground">
              <span data-testid="backfill-records" className="font-medium text-foreground">
                {formatCount(job.records_processed)}
              </span>{' '}
              orders imported
            </p>
          )}
          {job.achieved_depth_label && (
            <p data-testid="backfill-depth-label" className="text-sm text-muted-foreground">
              {job.achieved_depth_label}
            </p>
          )}
        </div>
      )}

      {/* ── Trigger button (brand_admin+ only, idle or no job yet) ──────── */}
      {canTrigger && !hasActiveJob && !hasTerminalJob && (
        <Button
          size="sm"
          variant="outline"
          onClick={handleTrigger}
          disabled={isTriggering}
          data-testid="backfill-trigger"
          aria-label="Import Shopify order history"
          aria-describedby="backfill-trigger-hint"
        >
          {isTriggering ? (
            <>
              <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" aria-hidden="true" />
              Starting…
            </>
          ) : (
            <>
              <Download className="mr-2 h-3.5 w-3.5" aria-hidden="true" />
              Import History
            </>
          )}
        </Button>
      )}

      {canTrigger && !hasActiveJob && !hasTerminalJob && (
        <p
          id="backfill-trigger-hint"
          className="text-xs text-muted-foreground"
          aria-live="polite"
        >
          Imports up to 24 months of Shopify order history.
        </p>
      )}

      {/* Manager sees nothing for the trigger — mirrors server 403 (D-15) */}
    </div>
  );
}
