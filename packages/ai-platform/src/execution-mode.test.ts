// SPEC: F.4
import { describe, it, expect } from 'vitest';

import {
  EXECUTION_MODES,
  DEFAULT_EXECUTION_MODE,
  isExecutionMode,
  assertExecutionModeReachable,
  AutoExecutionNotGovernedError,
} from './execution-mode.js';

describe('SPEC:F.4 execution_mode enum — auto unreachable by construction', () => {
  it('declares exactly suggest|approve|auto', () => {
    expect([...EXECUTION_MODES]).toEqual(['suggest', 'approve', 'auto']);
  });

  it('defaults to the safe suggest', () => {
    expect(DEFAULT_EXECUTION_MODE).toBe('suggest');
  });

  it('type-guards unknown strings out', () => {
    expect(isExecutionMode('suggest')).toBe(true);
    expect(isExecutionMode('auto')).toBe(true);
    expect(isExecutionMode('destroy')).toBe(false);
    expect(isExecutionMode(42)).toBe(false);
  });

  it('suggest/approve are inert (reachable as data, no throw)', () => {
    expect(() => assertExecutionModeReachable('suggest')).not.toThrow();
    expect(() => assertExecutionModeReachable('approve')).not.toThrow();
  });

  it('auto ALWAYS throws — no governed path exists in the scaffold (Wave I gate)', () => {
    expect(() => assertExecutionModeReachable('auto')).toThrow(AutoExecutionNotGovernedError);
  });
});
