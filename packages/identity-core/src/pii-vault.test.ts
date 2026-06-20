/**
 * pii-vault.test.ts — AES-256-GCM envelope encryption for the contact_pii vault (P0-C).
 *
 * Proves: round-trip; fail-closed on tampered ciphertext/IV/tag; fail-closed on the wrong
 * DEK; DEK length enforcement; and that the dev DEK is deterministic per brand (32 bytes).
 */
import { describe, it, expect } from 'vitest';
import { randomBytes } from 'node:crypto';
import { encryptPii, decryptPii, deriveDevVaultDek } from './index.js';

const DEK = randomBytes(32);

describe('encryptPii / decryptPii (AES-256-GCM)', () => {
  it('round-trips a value', () => {
    const env = encryptPii(DEK, 'user@example.com');
    expect(decryptPii(DEK, env)).toBe('user@example.com');
  });

  it('produces a fresh IV each call (ciphertext is non-deterministic)', () => {
    const a = encryptPii(DEK, '+919876543210');
    const b = encryptPii(DEK, '+919876543210');
    expect(a.iv.equals(b.iv)).toBe(false);
    expect(a.ciphertext.equals(b.ciphertext)).toBe(false);
    expect(decryptPii(DEK, a)).toBe('+919876543210');
    expect(decryptPii(DEK, b)).toBe('+919876543210');
  });

  it('FAILS CLOSED on a tampered ciphertext', () => {
    const env = encryptPii(DEK, 'secret@example.com');
    const tampered = { ...env, ciphertext: Buffer.from(env.ciphertext) };
    // Flip a byte to corrupt the ciphertext. Non-null assert: index 0 exists (non-empty buffer);
    // the bare `^=` trips noUncheckedIndexedAccess (read is number|undefined).
    tampered.ciphertext[0] = tampered.ciphertext[0]! ^ 0xff;
    expect(() => decryptPii(DEK, tampered)).toThrow();
  });

  it('FAILS CLOSED on a tampered auth tag', () => {
    const env = encryptPii(DEK, 'secret@example.com');
    const tampered = { ...env, authTag: Buffer.from(env.authTag) };
    tampered.authTag[0] = tampered.authTag[0]! ^ 0xff;
    expect(() => decryptPii(DEK, tampered)).toThrow();
  });

  it('FAILS CLOSED with the wrong DEK (crypto-shred / cross-brand)', () => {
    const env = encryptPii(DEK, 'secret@example.com');
    expect(() => decryptPii(randomBytes(32), env)).toThrow();
  });

  it('rejects a non-32-byte DEK', () => {
    expect(() => encryptPii(randomBytes(16), 'x')).toThrow('32 bytes');
    expect(() => decryptPii(randomBytes(31), encryptPii(DEK, 'x'))).toThrow('32 bytes');
  });
});

describe('deriveDevVaultDek', () => {
  it('is deterministic per brand and exactly 32 bytes', () => {
    const b = '11111111-1111-4111-8111-111111111111';
    const k1 = deriveDevVaultDek(b);
    const k2 = deriveDevVaultDek(b);
    expect(k1.length).toBe(32);
    expect(k1.equals(k2)).toBe(true);
  });

  it('differs across brands (cross-brand uncorrelatable)', () => {
    const k1 = deriveDevVaultDek('11111111-1111-4111-8111-111111111111');
    const k2 = deriveDevVaultDek('22222222-2222-4222-8222-222222222222');
    expect(k1.equals(k2)).toBe(false);
  });

  it('round-trips through encrypt/decrypt with the derived dev DEK', () => {
    const dek = deriveDevVaultDek('33333333-3333-4333-8333-333333333333');
    expect(decryptPii(dek, encryptPii(dek, 'a@b.com'))).toBe('a@b.com');
  });
});
