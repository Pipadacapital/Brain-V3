import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveRackId } from './resolveRackId.js';

const TOKEN = 'imds-token-xyz';
const AZ = 'ap-south-1b';

// Duck-typed fetch Response — avoids the lib.dom vs undici-types `Response` variance in the app
// tsconfig (test-only). Cast at the spy boundary.
const res = (body: string, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, text: async () => body }) as unknown as Response;

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.KAFKA_RACK_ID;
});

describe('resolveRackId', () => {
  it('prefers the KAFKA_RACK_ID override and never touches IMDS', async () => {
    process.env.KAFKA_RACK_ID = 'ap-south-1a';
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    await expect(resolveRackId()).resolves.toBe('ap-south-1a');
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('resolves the AZ via IMDSv2 (token PUT then AZ GET)', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init: RequestInit) =>
      init?.method === 'PUT' ? res(TOKEN) : res(AZ)) as typeof fetch);
    await expect(resolveRackId()).resolves.toBe(AZ);
  });

  it('returns "" (graceful no-rack) when the token PUT fails', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(res('', 401));
    await expect(resolveRackId()).resolves.toBe('');
  });

  it('returns "" when IMDS is unreachable (fetch throws)', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('ECONNREFUSED'));
    await expect(resolveRackId()).resolves.toBe('');
  });

  it('trims stray whitespace from the IMDS response', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation((async (_url: unknown, init: RequestInit) =>
      init?.method === 'PUT' ? res(`  ${TOKEN}  `) : res(`${AZ}\n`)) as typeof fetch);
    await expect(resolveRackId()).resolves.toBe(AZ);
  });
});
