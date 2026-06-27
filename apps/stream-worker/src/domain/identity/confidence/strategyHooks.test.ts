/**
 * strategyHooks.test.ts — pure-domain unit tests for the identity detection strategy hooks.
 *
 * Asserts the deterministic-first contract:
 *   • Exactly the deterministic merge / split / cross-device hooks are ENABLED + LIVE.
 *   • The probabilistic cross-device + household hooks are registered-DISABLED and throw
 *     NotImplementedYet on invoke — never a faked/empty detection.
 *   • Merge fires only on ≥2 strong brain_ids (canonical = lowest UUID, order-independent).
 *   • Cross-device fires only on a SINGLE medium brain_id with no strong evidence, and is
 *     ALWAYS mergeEligible=false (resolve-only).
 *
 * @effort("deterministic") — no model calls.
 */
import { describe, it, expect } from 'vitest';
import { NotImplementedYet } from '@brain/contracts';
import {
  DeterministicMergeHook,
  DeterministicSplitHook,
  DeterministicCrossDeviceHook,
  DisabledStrategyHook,
  IDENTITY_STRATEGY_HOOK_REGISTRY,
  createDefaultStrategyHooks,
  type StrategyEvidence,
} from './strategyHooks.js';

const BRAND = '22222222-2222-2222-2222-222222222222';
const A = 'aaaaaaaa-0000-0000-0000-000000000001';
const B = 'bbbbbbbb-0000-0000-0000-000000000002';
const C = 'cccccccc-0000-0000-0000-000000000003';

function ev(strong: string[], medium: string[]): StrategyEvidence {
  return { brand_id: BRAND, strongBrainIds: strong, mediumBrainIds: medium };
}

describe('IDENTITY_STRATEGY_HOOK_REGISTRY', () => {
  it('enables EXACTLY the deterministic hooks; everything else is disabled-not-implemented', () => {
    const enabled = IDENTITY_STRATEGY_HOOK_REGISTRY.filter((h) => h.status === 'enabled');
    const disabled = IDENTITY_STRATEGY_HOOK_REGISTRY.filter((h) => h.status === 'disabled-not-implemented');

    expect(enabled.every((h) => h.strategy === 'deterministic')).toBe(true);
    expect(enabled.map((h) => h.id).sort()).toEqual([
      'cross-device-deterministic',
      'merge-deterministic',
      'split-deterministic',
    ]);
    // Disabled = the probabilistic cross-device + the household hook (never deterministic).
    expect(disabled.map((h) => h.id).sort()).toEqual(['cross-device-probabilistic', 'household-graph']);
    expect(disabled.every((h) => h.strategy !== 'deterministic')).toBe(true);
  });
});

describe('DisabledStrategyHook — never fakes a detection (D-5)', () => {
  it('detect() throws NotImplementedYet carrying its id + strategy', () => {
    const hook = new DisabledStrategyHook('household-graph', 'household', 'ml');
    expect(hook.status).toBe('disabled-not-implemented');
    try {
      hook.detect(ev([], []));
      throw new Error('expected NotImplementedYet');
    } catch (e) {
      expect(e).toBeInstanceOf(NotImplementedYet);
      expect((e as NotImplementedYet).matcher_id).toBe('household-graph');
      expect((e as NotImplementedYet).strategy).toBe('ml');
    }
  });

  it('the default disabled hooks (probabilistic cross-device + household) both throw', () => {
    const { disabled } = createDefaultStrategyHooks();
    expect(disabled.map((h) => h.id).sort()).toEqual(['cross-device-probabilistic', 'household-graph']);
    for (const hook of disabled) {
      expect(() => hook.detect(ev([A], [B]))).toThrow(NotImplementedYet);
    }
  });
});

describe('DeterministicMergeHook', () => {
  const hook = new DeterministicMergeHook();

  it('fires + is merge-eligible on ≥2 distinct strong brain_ids; canonical = lowest UUID', () => {
    const d = hook.detect(ev([B, A], []));
    expect(d.applies).toBe(true);
    expect(d.mergeEligible).toBe(true);
    expect(d.brain_ids).toEqual([A, B]); // sorted
    expect(d.reasons).toContain(`merge:canonical=${A}`);
  });

  it('is order-independent — shuffling the strong brain_ids yields the identical detection', () => {
    const d1 = hook.detect(ev([A, B, C], []));
    const d2 = hook.detect(ev([C, A, B], []));
    expect(d2).toEqual(d1);
    expect(d1.brain_ids[0]).toBe(A); // canonical stable
  });

  it('does NOT fire on a single (or zero) strong brain_id', () => {
    expect(hook.detect(ev([A], [])).applies).toBe(false);
    expect(hook.detect(ev([], [])).applies).toBe(false);
    expect(hook.detect(ev([A], [])).mergeEligible).toBe(false);
  });

  it('dedups repeated strong brain_ids — same brain_id twice is NOT a merge', () => {
    expect(hook.detect(ev([A, A], [])).applies).toBe(false);
  });
});

describe('DeterministicCrossDeviceHook — resolve-only, NEVER merge', () => {
  const hook = new DeterministicCrossDeviceHook();

  it('fires (adopt) on zero strong + exactly one medium brain_id; mergeEligible is false', () => {
    const d = hook.detect(ev([], [A]));
    expect(d.applies).toBe(true);
    expect(d.mergeEligible).toBe(false);
    expect(d.brain_ids).toEqual([A]);
    expect(d.reasons).toContain('cross_device:deterministic_adopt');
  });

  it('does NOT fire on ambiguous (≥2) medium brain_ids — reports ambiguity, never merges', () => {
    const d = hook.detect(ev([], [A, B]));
    expect(d.applies).toBe(false);
    expect(d.mergeEligible).toBe(false);
    expect(d.reasons).toContain('cross_device:ambiguous');
  });

  it('does NOT fire when a strong brain_id already exists (strong wins)', () => {
    expect(hook.detect(ev([A], [B])).applies).toBe(false);
    expect(hook.detect(ev([A], [A])).applies).toBe(false);
  });
});

describe('DeterministicSplitHook — admin-only, event-path no-op', () => {
  it('never fires on the event path (split is an explicit admin Unmerge)', () => {
    const d = new DeterministicSplitHook().detect(ev([A, B], []));
    expect(d.applies).toBe(false);
    expect(d.mergeEligible).toBe(false);
    expect(d.reasons).toContain('split:admin_only');
  });
});
