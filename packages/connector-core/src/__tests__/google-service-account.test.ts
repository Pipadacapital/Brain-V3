/**
 * google-service-account.test.ts — the shared Google SA JWT-bearer helper (no live network).
 *
 * Covers:
 *   - parseServiceAccountKeyJson: happy path + every structural rejection (I-S09: errors never
 *     carry the key material).
 *   - signServiceAccountAssertion: a real RS256 signature over the correct claims, verifiable
 *     with node:crypto against the paired public key; garbage PEM → GOOGLE_SA_AUTH_ERROR.
 *   - mintServiceAccountAccessToken: jwt-bearer grant POST body; 4xx → GOOGLE_SA_AUTH_ERROR
 *     (non-retryable); 5xx → plain Error (retryable); 200 without access_token → auth error.
 */
import { describe, it, expect, vi } from 'vitest';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import {
  parseServiceAccountKeyJson,
  signServiceAccountAssertion,
  mintServiceAccountAccessToken,
  GOOGLE_SA_AUTH_ERROR,
  GOOGLE_OAUTH_TOKEN_URL,
} from '../auth/google-service-account.js';

// One RSA pair for the whole file (2048 bits keeps the test fast).
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const PRIVATE_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const CLIENT_EMAIL = 'brain-ga4@test-project.iam.gserviceaccount.com';
const SCOPE = 'https://www.googleapis.com/auth/analytics.readonly';

function keyJson(overrides?: Record<string, unknown>): string {
  return JSON.stringify({
    type: 'service_account',
    client_email: CLIENT_EMAIL,
    private_key: PRIVATE_PEM,
    ...overrides,
  });
}

describe('parseServiceAccountKeyJson', () => {
  it('parses a valid key JSON into { clientEmail, privateKeyPem }', () => {
    const key = parseServiceAccountKeyJson(keyJson());
    expect(key.clientEmail).toBe(CLIENT_EMAIL);
    expect(key.privateKeyPem).toContain('PRIVATE KEY');
  });

  it.each([
    ['not JSON at all', 'not-json{{{'],
    ['wrong type', keyJson({ type: 'authorized_user' })],
    ['missing client_email', JSON.stringify({ type: 'service_account', private_key: PRIVATE_PEM })],
    ['missing private_key', JSON.stringify({ type: 'service_account', client_email: CLIENT_EMAIL })],
    ['non-PEM private_key', keyJson({ private_key: 'hunter2' })],
  ])('rejects %s with GOOGLE_SA_AUTH_ERROR', (_label, raw) => {
    expect(() => parseServiceAccountKeyJson(raw)).toThrowError(GOOGLE_SA_AUTH_ERROR);
  });

  it('I-S09: the rejection message never contains the key material', () => {
    try {
      parseServiceAccountKeyJson(keyJson({ type: 'authorized_user' }));
      expect.unreachable();
    } catch (err) {
      expect((err as Error).message).not.toContain(PRIVATE_PEM.slice(30, 60));
    }
  });
});

describe('signServiceAccountAssertion', () => {
  it('produces a verifiable RS256 JWT with the documented claims', () => {
    const nowMs = Date.parse('2026-07-12T00:00:00Z');
    const jwt = signServiceAccountAssertion({
      key: { clientEmail: CLIENT_EMAIL, privateKeyPem: PRIVATE_PEM },
      scope: SCOPE,
      nowMs,
    });

    const [h, c, s] = jwt.split('.');
    expect(h && c && s).toBeTruthy();

    const header = JSON.parse(Buffer.from(h!, 'base64url').toString());
    expect(header).toEqual({ alg: 'RS256', typ: 'JWT' });

    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toEqual({
      iss: CLIENT_EMAIL,
      scope: SCOPE,
      aud: GOOGLE_OAUTH_TOKEN_URL,
      iat: Math.floor(nowMs / 1000),
      exp: Math.floor(nowMs / 1000) + 3600,
    });

    // The signature verifies against the paired public key (a REAL RS256 signature).
    const verifier = createVerify('RSA-SHA256');
    verifier.update(`${h}.${c}`);
    expect(verifier.verify(publicKey, Buffer.from(s!, 'base64url'))).toBe(true);
  });

  it('garbage PEM → GOOGLE_SA_AUTH_ERROR (never the PEM in the message)', () => {
    expect(() =>
      signServiceAccountAssertion({
        key: { clientEmail: CLIENT_EMAIL, privateKeyPem: '-----BEGIN PRIVATE KEY-----\ngarbage\n-----END PRIVATE KEY-----' },
        scope: SCOPE,
      }),
    ).toThrowError(GOOGLE_SA_AUTH_ERROR);
  });
});

describe('mintServiceAccountAccessToken', () => {
  const KEY = { clientEmail: CLIENT_EMAIL, privateKeyPem: PRIVATE_PEM };

  it('POSTs the jwt-bearer grant and returns the access token + expiry', async () => {
    const fetchImpl = vi.fn(async (_url: string | URL, init?: { body?: unknown }) => {
      const body = String(init?.body);
      expect(body).toContain('grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer');
      expect(body).toContain('assertion=');
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'ya29.test-token', expires_in: 3599 }),
      } as Response;
    }) as unknown as typeof fetch;

    const result = await mintServiceAccountAccessToken({ key: KEY, scope: SCOPE, fetchImpl });
    expect(result.accessToken).toBe('ya29.test-token');
    expect(result.expiresInSeconds).toBe(3599);
    expect(fetchImpl).toHaveBeenCalledWith(GOOGLE_OAUTH_TOKEN_URL, expect.anything());
  });

  it('4xx (invalid_grant) → GOOGLE_SA_AUTH_ERROR with err.code set (non-retryable)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 400,
      json: async () => ({ error: 'invalid_grant' }),
    })) as unknown as typeof fetch;

    const p = mintServiceAccountAccessToken({ key: KEY, scope: SCOPE, fetchImpl });
    await expect(p).rejects.toMatchObject({ code: GOOGLE_SA_AUTH_ERROR });
  });

  it('5xx → plain Error WITHOUT the auth code (retryable by the caller)', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: false,
      status: 503,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    try {
      await mintServiceAccountAccessToken({ key: KEY, scope: SCOPE, fetchImpl });
      expect.unreachable();
    } catch (err) {
      expect((err as { code?: string }).code).toBeUndefined();
    }
  });

  it('200 without access_token → GOOGLE_SA_AUTH_ERROR', async () => {
    const fetchImpl = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({}),
    })) as unknown as typeof fetch;

    await expect(
      mintServiceAccountAccessToken({ key: KEY, scope: SCOPE, fetchImpl }),
    ).rejects.toMatchObject({ code: GOOGLE_SA_AUTH_ERROR });
  });
});
