/**
 * backfill-control.test.ts — unit tests for the "Pull historical data" trigger-control
 * decision logic (0127+ restore).
 *
 * Regression guard for the reported UX bug: once a backfill job existed (e.g. a FAILED job),
 * the depth/period picker vanished and only a "Retry Import" button showed — users read this
 * as "the historical-data-by-period feature was removed." The picker + trigger must be
 * available in EVERY terminal state (completed / partial / failed), not only when idle;
 * it is hidden ONLY while a job is actively queued/running.
 *
 * These tests exercise the two pure decision helpers that drive the render:
 *   - shouldShowTriggerControl(canTrigger, status): picker+trigger visibility.
 *   - triggerLabel(status): context-aware button copy + aria-label.
 *
 * Kept as pure-logic tests (no React render) to match the repo's node-env vitest setup — the
 * component has no rendering test harness (no testing-library / jsdom). The two exported
 * helpers are the SAME functions the JSX uses, so they guard the actual render path.
 */

import { describe, it, expect } from 'vitest';
import {
  shouldShowTriggerControl,
  triggerLabel,
} from './backfill-control-logic';
import type { BackfillJobProgress } from '@brain/contracts';

type Status = BackfillJobProgress['status'];

const TERMINAL: Status[] = ['completed', 'partial', 'failed'];
const ACTIVE: Status[] = ['queued', 'running'];

describe('shouldShowTriggerControl — picker + trigger visibility', () => {
  it('shows the control when idle (no job) for a brand_admin+', () => {
    expect(shouldShowTriggerControl(true, undefined)).toBe(true);
  });

  it.each(TERMINAL)(
    'shows the control in the %s terminal state (regression: picker must NOT vanish)',
    (status) => {
      expect(shouldShowTriggerControl(true, status)).toBe(true);
    },
  );

  it.each(ACTIVE)(
    'hides the control while a job is actively %s',
    (status) => {
      expect(shouldShowTriggerControl(true, status)).toBe(false);
    },
  );

  it.each([undefined, ...TERMINAL, ...ACTIVE] as (Status | undefined)[])(
    'always hides the control for a non-admin (canTrigger=false), status=%s',
    (status) => {
      expect(shouldShowTriggerControl(false, status)).toBe(false);
    },
  );
});

describe('triggerLabel — context-aware button copy + aria-label', () => {
  it('reads "Import History" / "Import order history" when idle', () => {
    expect(triggerLabel(undefined)).toEqual({
      text: 'Import History',
      ariaLabel: 'Import order history',
    });
  });

  it('reads "Import History" after a completed job (not a retry)', () => {
    expect(triggerLabel('completed')).toEqual({
      text: 'Import History',
      ariaLabel: 'Import order history',
    });
  });

  it.each(['failed', 'partial'] as Status[])(
    'reads "Retry Import" / "Retry backfill import" for the %s terminal state',
    (status) => {
      expect(triggerLabel(status)).toEqual({
        text: 'Retry Import',
        ariaLabel: 'Retry backfill import',
      });
    },
  );

  it.each(ACTIVE)(
    'defaults to "Import History" for the transient %s status (control is hidden anyway)',
    (status) => {
      expect(triggerLabel(status)).toEqual({
        text: 'Import History',
        ariaLabel: 'Import order history',
      });
    },
  );
});

describe('scenario: given a FAILED job, an admin sees the picker + a "Retry Import" trigger', () => {
  it('failed → control visible AND labeled "Retry Import"', () => {
    expect(shouldShowTriggerControl(true, 'failed')).toBe(true);
    expect(triggerLabel('failed').text).toBe('Retry Import');
  });

  it('completed → control visible AND labeled "Import History"', () => {
    expect(shouldShowTriggerControl(true, 'completed')).toBe(true);
    expect(triggerLabel('completed').text).toBe('Import History');
  });
});
