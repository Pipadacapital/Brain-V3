import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

/**
 * The ONLY thing that matters about dev-link-capture is its production gate:
 * verification/reset tokens must NEVER be retained or returned in production.
 * DEV_LINKS_ENABLED is computed at module load, so each case resets modules and
 * re-imports under a stubbed NODE_ENV.
 */
describe('dev-link-capture — production gate (security-critical)', () => {
  beforeEach(() => vi.resetModules());
  afterEach(() => vi.unstubAllEnvs());

  it('DEV: captures and returns links (case-insensitive) when NODE_ENV !== production', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const mod = await import('../internal/dev-link-capture.js');
    expect(mod.DEV_LINKS_ENABLED).toBe(true);

    mod.captureDevLink('Foo@Example.com', {
      type: 'email_verification', token: 'tok-1', url: 'http://localhost:3000/verify-email?token=tok-1', capturedAt: '2026-06-16T00:00:00Z',
    });
    expect(mod.getDevLink('foo@example.com')?.token).toBe('tok-1');
  });

  it('PRODUCTION: never captures and never returns a token when NODE_ENV === production', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const mod = await import('../internal/dev-link-capture.js');
    expect(mod.DEV_LINKS_ENABLED).toBe(false);

    // Even if a caller forgets the gate, capture is a no-op and get yields nothing.
    mod.captureDevLink('foo@example.com', {
      type: 'email_verification', token: 'leak', url: 'http://x', capturedAt: '2026-06-16T00:00:00Z',
    });
    expect(mod.getDevLink('foo@example.com')).toBeUndefined();
  });
});
