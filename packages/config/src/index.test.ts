/**
 * @brain/config — requireEnvInProd tests.
 *
 * Guards the prod fail-closed contract: a credential env var falls back to its dev default OUTSIDE
 * production, but in production a missing value is a hard error (never reuse a known weak default).
 */
import { describe, it, expect, vi, afterEach } from 'vitest';
import { z } from 'zod';
import { parseEnv, requireEnvInProd } from './index.js';

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

describe('parseEnv (AUD-IMPL-007 — VITEST gate)', () => {
  const impossible = z.object({ __AUD_IMPL_007_REQUIRED__: z.string().min(1) });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it('THROWS (never process.exit) on invalid process.env inside a vitest worker', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    // env defaults to process.env AND VITEST is set by the vitest runtime →
    // the exit branch must be skipped so unit assertions see the real Error.
    expect(process.env['VITEST']).toBeTruthy();
    expect(() => parseEnv(impossible)).toThrow(/Invalid environment configuration/);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('still exits for real services (process.env without VITEST)', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit(1)');
    }) as never);
    vi.stubEnv('VITEST', '');
    expect(() => parseEnv(impossible)).toThrow(/exit\(1\)/);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('throws (no exit) when handed an explicit env map', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    expect(() => parseEnv(impossible, {})).toThrow(/Invalid environment configuration/);
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
