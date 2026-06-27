/**
 * @brain/config — requireEnvInProd tests.
 *
 * Guards the prod fail-closed contract: a credential env var falls back to its dev default OUTSIDE
 * production, but in production a missing value is a hard error (never reuse a known weak default).
 */
import { describe, it, expect } from 'vitest';
import { requireEnvInProd } from './index.js';

describe('requireEnvInProd', () => {
  it('returns the set value regardless of environment', () => {
    expect(requireEnvInProd('X', 'devpw', { NODE_ENV: 'production', X: 'real-secret' })).toBe('real-secret');
    expect(requireEnvInProd('X', 'devpw', { NODE_ENV: 'development', X: 'real-secret' })).toBe('real-secret');
  });

  it('falls back to the dev default outside production', () => {
    expect(requireEnvInProd('X', 'devpw', { NODE_ENV: 'development' })).toBe('devpw');
    expect(requireEnvInProd('X', 'devpw', { NODE_ENV: 'test' })).toBe('devpw');
    expect(requireEnvInProd('X', 'devpw', {})).toBe('devpw'); // unset NODE_ENV → not production
  });

  it('FAILS CLOSED in production when unset or empty — never the weak default', () => {
    expect(() => requireEnvInProd('BRAIN_APP_DATABASE_URL', 'postgres://brain_app:brain_app@localhost:5432/brain', { NODE_ENV: 'production' }))
      .toThrow(/must be set in production/);
    expect(() => requireEnvInProd('X', 'devpw', { NODE_ENV: 'production', X: '' }))
      .toThrow(/must be set in production/);
  });
});
