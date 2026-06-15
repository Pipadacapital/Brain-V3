// FIXTURE: should trigger no-raw-redis-key (NN-7)
// This file must NOT be imported in production code. It exists only for lint verification.

declare const redis: {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<void>;
};

declare const brandId: string;

// Violation 1: string concatenation key on redis client
async function bad1() {
  return redis.get('brand:' + brandId + ':metric');
}

// Violation 2: template literal key on redis client
async function bad2() {
  return redis.get(`brand:${brandId}:metric`);
}

// Violation 3: bare string literal key
async function bad3() {
  return redis.set('some:raw:key', 'value');
}

// Passing (intentionally safe — these should NOT trigger):
// import { brandKey } from '@brain/tenant-context';
// const key = brandKey({ brandId, metricId: 'gmv', version: 1, filtersHash: 'abc', grain: 'day', asOf: new Date() });
// redis.get(key);
