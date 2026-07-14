/**
 * SaltProvider — per-brand identity salt fetch + hard-crash guard (D-2 CRITICAL).
 *
 * The SecretsProvider interface is mirrored here (Single-Primitive intent preserved:
 * the same getSecret(nameOrArn) contract, same fail-closed throw behaviour).
 * In dev: LocalSecretsProvider (apps/core) pattern — env var holds the raw value.
 * In prod: AwsSecretsProvider (apps/core) pattern — ARN resolved via KMS.
 *
 * HARD CRASH CONTRACT (D-2 load-bearing):
 *   If the salt fetch throws OR the decoded salt is not exactly 32 bytes:
 *     → throw Error('[identity-bridge] salt fetch failed — ...')
 *     → the process exits non-zero (never hashes with empty/default salt).
 *   A shared or empty salt = identical hashes across brands = cross-brand
 *   correlation = the ONE invariant violated. There is no acceptable fallback.
 *
 * Salt encoding: the secret value is a 64-char lowercase hex string encoding
 * exactly 32 bytes (256 bits). The provider decodes it to a Buffer and validates
 * the length before caching.
 *
 * Dev usage: supply a 64-hex string directly via env var (LocalSecretsProvider
 * returns it as-is). Prod: store the hex-encoded 32-byte salt in AWS Secrets
 * Manager, encrypted under the brand's KMS DEK.
 */

// resolveSaltHex (the ONE salt-resolution order shared by core + worker — §3.1) lives in
// @brain/identity-core so the SAME brand resolves the SAME salt in every process. Every
// worker salt-closure (main.ts + each repull) calls it directly; no worker-local copy.

import { Pool as PgPool } from 'pg';
import { resolveSaltHex } from '@brain/identity-core';
import { KmsBrandSaltProvider, AwsKmsDecryptAdapter } from '@brain/pii-vault';

/** Minimal SecretsProvider interface (mirrors apps/core/src/infrastructure/secrets/SecretsProvider.ts). */
export interface SecretsProvider {
  getSecret(nameOrArn: string): Promise<string>;
}

/** LocalSecretsProvider — dev implementation (mirrors apps/core). */
export class LocalSecretsProvider implements SecretsProvider {
  async getSecret(value: string): Promise<string> {
    if (!value) {
      throw new Error('[LocalSecretsProvider] Empty secret value — check the env var');
    }
    return value;
  }
}

/**
 * Prod salt source as a SecretsProvider. In production the per-brand salt is NOT in an env var
 * (a runtime-created brand has none) — it is KMS-wrapped in tenancy.brand_identity_salt (0109) and
 * read via get_brand_identity_salt. This adapter resolves the 64-hex salt from that DB store keyed by
 * brandId, so SaltProvider's seam (and its D-2 length guards) stay unchanged.
 */
class DbSaltSecretsProvider implements SecretsProvider {
  constructor(private readonly src: { saltHexForBrand(brandId: string): Promise<string> }) {}
  async getSecret(brandId: string): Promise<string> {
    return this.src.saltHexForBrand(brandId);
  }
}

/**
 * Build the per-brand SaltProvider for the current environment. DEV: env-backed (LocalSecretsProvider
 * + resolveSaltHex's deterministic dev salt). PROD: the DB identity-salt store (KmsBrandSaltProvider,
 * KMS-unwrapped) — runtime-created brands have no IDENTITY_SALT env, so prod must read the provisioned
 * DB salt. Use this in main.ts AND every repull job so all salt sites resolve identically.
 */
export function createSaltProvider(dbUrl: string): SaltProvider {
  if (process.env['NODE_ENV'] === 'production') {
    const pool = new PgPool({ connectionString: dbUrl, max: 2 });
    const dbSalt = new KmsBrandSaltProvider(pool, new AwsKmsDecryptAdapter());
    return new SaltProvider(new DbSaltSecretsProvider(dbSalt), (brandId) => brandId);
  }
  return new SaltProvider(new LocalSecretsProvider(), resolveSaltHex);
}

/** Cache entry: Buffer of exactly 32 bytes. */
interface SaltCacheEntry {
  salt: Buffer;
  fetchedAt: number;
}

/** Cache TTL: 5 minutes (salts are stable; avoid KMS hammering on per-event fetches). */
const CACHE_TTL_MS = 5 * 60 * 1_000;

export class SaltProvider {
  /** In-memory per-brand salt cache. Bounded by number of active brands. */
  private readonly cache = new Map<string, SaltCacheEntry>();

  /**
   * @param secrets   The underlying SecretsProvider (Local in dev, Aws in prod).
   * @param saltArnFn Maps a brandId to its salt secret ARN/name or raw hex (dev).
   *                  In dev: returns the env var value directly (LocalSecretsProvider
   *                  treats the "ARN" as the raw hex value).
   */
  constructor(
    private readonly secrets: SecretsProvider,
    private readonly saltArnFn: (brandId: string) => string,
  ) {}

  /**
   * Fetch and decode the 32-byte salt for a brand.
   *
   * HARD CRASH on failure (D-2): throws if:
   *   - secrets.getSecret() throws (KMS error, missing ARN, empty value)
   *   - the decoded buffer is not exactly 32 bytes
   *   - the hex string has invalid characters or wrong length
   *
   * @param brandId  UUID of the brand (used to derive the secret ARN/name).
   * @returns        32-byte Buffer — the per-brand salt for SHA-256 hashing.
   * @throws         Error on ANY fetch or decode failure — caller must not catch
   *                 and continue with a fallback (process must die).
   */
  async forBrand(brandId: string): Promise<Buffer> {
    // Check cache
    const now = Date.now();
    const cached = this.cache.get(brandId);
    if (cached && now - cached.fetchedAt < CACHE_TTL_MS) {
      return cached.salt;
    }

    const arn = this.saltArnFn(brandId);

    let raw: string;
    try {
      raw = await this.secrets.getSecret(arn);
    } catch (err) {
      // Re-throw with identity-bridge prefix so the process crash is attributable.
      throw new Error(
        `[identity-bridge] salt fetch failed for brand ${brandId} — ` +
        `refusing to hash with empty/default salt (D-2): ${String(err)}`,
      );
    }

    if (!raw || raw.trim() === '') {
      throw new Error(
        `[identity-bridge] salt fetch returned empty value for brand ${brandId} — ` +
        `refusing to hash (D-2)`,
      );
    }

    // Decode 64-char hex → 32 bytes
    const trimmed = raw.trim();
    let salt: Buffer;
    try {
      salt = Buffer.from(trimmed, 'hex');
    } catch (err) {
      throw new Error(
        `[identity-bridge] salt hex decode failed for brand ${brandId}: ${String(err)}`,
      );
    }

    // CRITICAL length guard: must be exactly 32 bytes (256 bits).
    // Wrong length = wrong salt = cross-brand hash collision risk (D-2).
    if (!salt || salt.length !== 32) {
      throw new Error(
        `[identity-bridge] salt for brand ${brandId} is ${salt?.length ?? 0} bytes; ` +
        `expected 32 bytes. Refusing to hash with wrong-length salt (D-2).`,
      );
    }

    // Cache the validated salt
    this.cache.set(brandId, { salt, fetchedAt: now });
    return salt;
  }

  /**
   * Return the cached salt as a 64-char hex string
   * (suitable for passing to hashIdentifier as perBrandSalt).
   */
  async saltHexForBrand(brandId: string): Promise<string> {
    const buf = await this.forBrand(brandId);
    return buf.toString('hex');
  }

  /** Clear the salt cache (used in tests to force re-fetch). */
  clearCache(): void {
    this.cache.clear();
  }
}
