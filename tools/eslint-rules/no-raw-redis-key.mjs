/**
 * ESLint rule: no-raw-redis-key (NN-7)
 *
 * Bans construction of Redis keys as raw strings outside of tenant-context.brandKey().
 * Raw key construction allows cross-brand data leakage if the brand_id is missing.
 *
 * The only sanctioned key builder is:
 *   import { brandKey } from '@brain/tenant-context';
 *   const key = brandKey({ brandId, metricId, ... });
 *
 * Failing fixtures:
 *   redis.get('brand:' + brandId + ':metric');          // string concatenation — ERROR
 *   redis.set(`brand:${brandId}:metric`, value);        // template literal — ERROR
 *   client.get('some:raw:key');                         // bare string on redis client — ERROR
 *
 * Passing fixture:
 *   const key = brandKey({ brandId, metricId, version, filtersHash, grain, asOf });
 *   redis.get(key);                                     // passes through brandKey() — OK
 */

/** Redis client method names that accept a key as their first argument. */
const REDIS_READ_WRITE_METHODS = new Set([
  'get', 'set', 'del', 'exists', 'expire', 'ttl', 'incr', 'decr',
  'hget', 'hset', 'hdel', 'hgetall', 'hmget', 'hmset',
  'lpush', 'rpush', 'lrange', 'llen', 'lrem',
  'sadd', 'srem', 'smembers', 'sismember', 'scard',
  'zadd', 'zrem', 'zscore', 'zrange', 'zrangebyscore', 'zcard',
  'getex', 'getdel', 'setnx', 'setex', 'psetex',
  'mget', 'mset', 'msetnx',
  'eval', 'evalsha',
  'xadd', 'xread', 'xlen',
]);

/** Variable/object names that signal a Redis client. */
const REDIS_CLIENT_NAMES = /^(redis|redisClient|cache|cacheClient|ioredis|client)$/i;

/**
 * Returns true if the expression is a raw string key (string literal, template literal
 * with expressions, or binary '+' concatenation involving a string).
 */
function isRawKeyExpression(node) {
  if (!node) return false;

  // String literal: 'some:key'
  if (node.type === 'Literal' && typeof node.value === 'string') return true;

  // Template literal with expressions: `brand:${id}`
  if (node.type === 'TemplateLiteral' && node.expressions.length > 0) return true;

  // Binary concat: 'prefix:' + id
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return isRawKeyExpression(node.left) || isRawKeyExpression(node.right);
  }

  return false;
}

/**
 * Returns true if the expression is a call to brandKey() from @brain/tenant-context.
 * We check the callee name only (import aliasing is the developer's responsibility).
 */
function isBrandKeyCall(node) {
  if (!node) return false;
  if (node.type !== 'CallExpression') return false;
  const callee = node.callee;
  // brandKey(...)
  if (callee.type === 'Identifier' && callee.name === 'brandKey') return true;
  // tenantContext.brandKey(...)
  if (
    callee.type === 'MemberExpression' &&
    callee.property?.name === 'brandKey'
  )
    return true;
  return false;
}

/**
 * Returns true if node is a safe key: a variable reference (we trust the developer
 * computed it via brandKey) or an actual brandKey() call.
 */
function isSafeKey(node) {
  if (!node) return false;
  if (isBrandKeyCall(node)) return true;
  // Identifier = presumably a variable computed elsewhere; we only flag raw construction
  if (node.type === 'Identifier') return true;
  return false;
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow raw Redis key string construction outside tenant-context.brandKey() (NN-7, I-S01).',
      category: 'Brain — Tenant Isolation',
      recommended: true,
    },
    schema: [],
    messages: {
      rawRedisKey:
        'Raw Redis key construction detected. Use brandKey() from @brain/tenant-context to build all Redis keys. Raw keys bypass tenant isolation (NN-7).',
    },
  },

  create(context) {
    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== 'MemberExpression') return;

        const object = callee.object;
        const method = callee.property?.name;

        if (!method || !REDIS_READ_WRITE_METHODS.has(method)) return;

        // Check if the call is on a known redis client name
        const objectName =
          object.type === 'Identifier'
            ? object.name
            : object.type === 'MemberExpression'
            ? object.property?.name
            : null;

        if (!objectName || !REDIS_CLIENT_NAMES.test(objectName)) return;

        // The first argument is the key
        const keyArg = node.arguments[0];
        if (!keyArg) return;

        if (isRawKeyExpression(keyArg) && !isSafeKey(keyArg)) {
          context.report({
            node: keyArg,
            messageId: 'rawRedisKey',
          });
        }
      },
    };
  },
};
