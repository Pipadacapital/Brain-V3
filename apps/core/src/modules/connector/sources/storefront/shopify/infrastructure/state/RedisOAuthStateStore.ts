/**
 * RedisOAuthStateStore — production implementation of IOAuthStateStore (Scale-C4).
 *
 * The in-process store (InProcessOAuthStateStore) keeps nonces in a per-pod Map, so in a
 * multi-replica deployment the OAuth callback can land on a DIFFERENT pod than the one that
 * initiated the flow → the state nonce isn't found → every OAuth connect fails intermittently.
 * This store moves the nonce to Redis (shared across pods), keyed by state value, with native
 * TTL expiry. Shared by every OAuth connector (Shopify, Meta, Google) via the IOAuthStateStore
 * seam — one store, all providers.
 *
 * NN-4 (single-use): consume is an ATOMIC get-and-delete via a tiny Lua script — no read-modify
 * -delete TOCTOU window, so a replayed callback can never consume the same nonce twice even under
 * concurrent pods. (Lua GET+DEL also works on Redis < 6.2 where GETDEL is unavailable.)
 *
 * MED-CALLBACK-01: brandId is the Redis VALUE (server-side, authoritative) — the callback derives
 * it from the stored record, never from the attacker-controlled query string.
 *
 * FAIL-CLOSED (unlike the dedup adapter's fail-open): this is a CSRF control. If Redis is
 * unavailable we cannot prove a nonce is valid + single-use, so:
 *   - set() THROWS → OAuth initiation aborts (never start a flow whose state can't be persisted).
 *   - consumeAndGetBrandId() returns null → the callback is rejected (no token exchange).
 * Either way an attacker gains nothing and a legitimate flow fails safe (the user retries).
 *
 * Key scheme: `shopify:oauth:state:{state}` — identical to InProcessOAuthStateStore (a precise
 * drop-in). The "shopify" segment is a historical namespace; the store serves all providers.
 */
import type { Redis } from 'ioredis';
import type { IOAuthStateStore } from './IOAuthStateStore.js';
import { OAuthStateNonce } from '../../domain/value-objects/OAuthStateNonce.js';
import { log } from '../../../../../../../log.js';

/** Atomic single-use consume: return the value and delete it in one round-trip (NN-4). */
const CONSUME_LUA = `local v = redis.call('GET', KEYS[1]); if v then redis.call('DEL', KEYS[1]) end; return v`;

export class RedisOAuthStateStore implements IOAuthStateStore {
  private readonly keyPrefix = 'shopify:oauth:state:';

  constructor(private readonly redis: Redis) {}

  async set(brandId: string, state: string, ttlSeconds: number): Promise<void> {
    const key = `${this.keyPrefix}${state}`;
    // NX: never clobber an existing nonce (a state collision is astronomically unlikely with a
    // 16-byte random nonce, but NX makes a collision fail rather than silently rebind a brand).
    // EX: native TTL — an unconsumed nonce expires server-side (no manual expiry check needed).
    let result: string | null;
    try {
      result = await this.redis.set(key, brandId, 'EX', ttlSeconds, 'NX');
    } catch (err) {
      // FAIL-CLOSED: cannot persist the nonce → do not start the OAuth flow.
      log.error(JSON.stringify({
        msg: 'oauth_state_redis_set_failed',
        event: 'redis_unavailable_fail_closed',
        level: 'error',
        err: err instanceof Error ? err.message : String(err),
      }));
      throw new Error('OAuth state store unavailable — cannot initiate connect.');
    }
    if (result === null) {
      // Key already existed (collision) — refuse rather than rebind. Caller surfaces a retry.
      throw new Error('OAuth state nonce collision — please retry the connect.');
    }
  }

  async consumeAndGetBrandId(state: string): Promise<{ brandId: string } | null> {
    const key = `${this.keyPrefix}${state}`;
    try {
      // Atomic GET+DEL (single-use, NN-4). Expired/absent/already-consumed → nil.
      const brandId = (await this.redis.eval(CONSUME_LUA, 1, key)) as string | null;
      if (!brandId) return null;
      return { brandId };
    } catch (err) {
      // FAIL-CLOSED: cannot validate the nonce → reject the callback (no token exchange).
      log.error(JSON.stringify({
        msg: 'oauth_state_redis_consume_failed',
        event: 'redis_unavailable_fail_closed',
        level: 'error',
        err: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  }

  async peekBrandId(state: string): Promise<{ brandId: string } | null> {
    const key = `${this.keyPrefix}${state}`;
    try {
      // Read-only GET (no DEL) — resolve the brand to pick its per-app client_secret for HMAC.
      const brandId = (await this.redis.get(key)) as string | null;
      if (!brandId) return null;
      return { brandId };
    } catch (err) {
      log.error(JSON.stringify({
        msg: 'oauth_state_redis_peek_failed',
        event: 'redis_unavailable_fail_closed',
        level: 'error',
        err: err instanceof Error ? err.message : String(err),
      }));
      return null;
    }
  }

  /** Expose TTL constant for use in handler (mirrors InProcessOAuthStateStore). */
  static readonly TTL_SECONDS = OAuthStateNonce.TTL_SECONDS;
}
