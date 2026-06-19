/**
 * logger.test.ts — the structured logger emits JSON with required fields, redacts PII (NN-6),
 * never leaks an Error stack, and honours bound context via child().
 */
import { describe, it, expect } from 'vitest';
import { createLogger } from './logger.js';

/** Capture pino output lines as parsed JSON. */
function capturing() {
  const lines: Array<Record<string, unknown>> = [];
  const destination = {
    write(s: string) {
      lines.push(JSON.parse(s));
    },
  };
  return { destination, lines };
}

describe('createLogger', () => {
  it('emits a structured JSON line with service, level, and msg', () => {
    const { destination, lines } = capturing();
    const log = createLogger({ serviceName: 'core', level: 'debug', destination });
    log.info('server listening', { port: 3001 });

    expect(lines).toHaveLength(1);
    const rec = lines[0]!;
    expect(rec['service']).toBe('core');
    expect(rec['msg']).toBe('server listening');
    expect(rec['port']).toBe(3001);
    expect(rec['level']).toBe(30); // pino info
  });

  it('redacts PII-keyed fields before they reach the log (NN-6)', () => {
    const { destination, lines } = capturing();
    const log = createLogger({ serviceName: 'core', level: 'debug', destination });
    log.info('login', { email: 'pii@example.com', brand_id: 'b-1', count: 2 });

    const rec = lines[0]!;
    expect(rec['email']).toBe('[REDACTED]'); // PII key redacted
    expect(rec['brand_id']).toBe('b-1'); // tenant key kept
    expect(rec['count']).toBe(2);
  });

  it('reduces an Error to name+message and never logs the stack', () => {
    const { destination, lines } = capturing();
    const log = createLogger({ serviceName: 'core', level: 'debug', destination });
    const err = new Error('boom');
    log.error('startup failed', { err });

    const rec = lines[0]!;
    const logged = rec['err'] as { error_name: string; error_message: string; stack?: string };
    expect(logged.error_name).toBe('Error');
    expect(logged.error_message).toBe('boom');
    expect(logged.stack).toBeUndefined(); // stack never logged (may carry PII)
    expect(JSON.stringify(rec)).not.toContain('logger.test.ts'); // no stack frames leaked
  });

  it('child() binds context (brand_id, correlation_id) onto every line, redacting PII', () => {
    const { destination, lines } = capturing();
    const base = createLogger({ serviceName: 'stream-worker', level: 'debug', destination });
    const log = base.child({ brand_id: 'b-9', correlation_id: 'c-7', email: 'leak@x.com' });
    log.warn('dedup conflict');

    const rec = lines[0]!;
    expect(rec['brand_id']).toBe('b-9');
    expect(rec['correlation_id']).toBe('c-7');
    expect(rec['email']).toBe('[REDACTED]');
    expect(rec['level']).toBe(40); // warn
  });

  it('respects the level threshold (debug suppressed at info level)', () => {
    const { destination, lines } = capturing();
    const log = createLogger({ serviceName: 'core', level: 'info', destination });
    log.debug('verbose');
    log.info('kept');
    expect(lines).toHaveLength(1);
    expect(lines[0]!['msg']).toBe('kept');
  });
});
