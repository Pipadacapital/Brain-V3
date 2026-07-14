// SPEC: I
/**
 * Wave I contract tests (SCAFFOLD): the Action Platform is fail-closed by design.
 * Asserts every adapter throws NotImplemented, the governance gate refuses 'auto', and the
 * registry covers exactly the four named executors. No behavior is exercised — there is none.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  EXECUTOR_NAMES,
  EXECUTOR_REGISTRY,
  NotImplementedError,
  evaluateAutoGate,
  type ActionEnvelope,
  type ExecutorName,
} from './index.js';

const NAMES: ExecutorName[] = ['shopify-discount', 'meta-audience', 'messaging', 'webhook'];

function envelope(overrides: Partial<ActionEnvelope> = {}): ActionEnvelope {
  return {
    brand_id: '00000000-0000-0000-0000-000000000001',
    action_id: '00000000-0000-0000-0000-0000000000aa',
    executor: 'webhook',
    execution_mode: 'suggest',
    payload: {},
    ...overrides,
  };
}

describe('ExecutorPort adapters (fail-closed scaffold)', () => {
  it('registers exactly the four named executors', () => {
    expect(new Set(EXECUTOR_NAMES)).toEqual(new Set(NAMES));
  });

  for (const name of NAMES) {
    const adapter = EXECUTOR_REGISTRY[name];

    it(`${name}: name matches, flag is registered-shaped, rollback unsupported`, () => {
      expect(adapter.name).toBe(name);
      expect(adapter.flag).toMatch(/^actions\.executor\./);
      expect(adapter.supportsRollback).toBe(false); // governance: no rollback → no 'auto'
    });

    it(`${name}: execute() throws NotImplemented`, async () => {
      await expect(adapter.execute(envelope({ executor: name }))).rejects.toBeInstanceOf(
        NotImplementedError,
      );
    });

    it(`${name}: rollback() throws NotImplemented`, async () => {
      await expect(adapter.rollback(envelope({ executor: name }), 'ref').catch((e) => {
        throw e;
      })).rejects.toBeInstanceOf(NotImplementedError);
    });
  }
});

describe('Wave-I governance gate', () => {
  it('permits non-auto modes without preconditions', () => {
    expect(evaluateAutoGate(envelope({ execution_mode: 'suggest' }), EXECUTOR_REGISTRY.webhook).allowed).toBe(true);
    expect(evaluateAutoGate(envelope({ execution_mode: 'approve' }), EXECUTOR_REGISTRY.webhook).allowed).toBe(true);
  });

  it('refuses auto when preconditions are missing (fail-closed)', () => {
    const r = evaluateAutoGate(
      envelope({ execution_mode: 'auto', executor: 'webhook' }),
      EXECUTOR_REGISTRY.webhook,
    );
    expect(r.allowed).toBe(false);
    expect(r.missing).toContain('policy_version');
    expect(r.missing).toContain('holdout_group');
    expect(r.missing).toContain('executor_rollback');
  });

  it('still refuses auto even with policy+holdout while rollback is unimplemented', () => {
    const r = evaluateAutoGate(
      envelope({ execution_mode: 'auto', policy_version: 'v1', holdout_group: 'holdout' }),
      EXECUTOR_REGISTRY.webhook,
    );
    expect(r.allowed).toBe(false);
    expect(r.missing).toEqual(['executor_rollback']);
  });
});

describe('action.*.v1 JSON Schema envelopes', () => {
  const SCHEMAS = ['requested', 'approved', 'executed', 'failed', 'rolled_back'];

  for (const s of SCHEMAS) {
    it(`brain.action.${s}.v1: brand_id first + required, holdout_group present, executor enum matches adapters`, () => {
      const p = fileURLToPath(
        new URL(`../../contracts/generated/json-schema/brain.action.${s}.v1.json`, import.meta.url),
      );
      const schema = JSON.parse(readFileSync(p, 'utf-8'));
      const props = Object.keys(schema.properties);
      expect(props[0]).toBe('brand_id'); // tenant-first (I-S01)
      expect(schema.required[0]).toBe('brand_id');
      expect(props).toContain('holdout_group'); // in the envelope from day one
      expect(schema.properties.executor.enum).toEqual(NAMES);
    });
  }
});
