// SPEC: E
import { describe, it, expect } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  loadFeatureRegistry,
  loadFeatureRegistryFrom,
  resolveAsOfFeatures,
  materializeOnline,
  materializeOffline,
  FeatureLayerNotImplementedError,
  type RawFeatureDoc,
} from './loader.js';
import { validateFeatureDefinition, FeatureDefinitionError } from './registry.js';
import { parseFlatFeatureYaml } from './infrastructure/flat-yaml.js';
import { createFsFeatureSource } from './infrastructure/fs-source.js';
import { isFeatureEntityType, isFeatureDtype, onlineFeatureKeyTemplate } from './schema.js';

const FEATURES_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'features');

const doc = (source: string, raw: string): RawFeatureDoc => ({ source, raw });

describe('E — feature registry loader (scaffold)', () => {
  it('loads + validates the shipped features/*.yaml registry', async () => {
    const reg = await loadFeatureRegistryFrom(createFsFeatureSource(FEATURES_DIR), parseFlatFeatureYaml);
    // At least the four seed declarations, sorted, unique names.
    expect(reg.all.length).toBeGreaterThanOrEqual(4);
    expect(new Set(reg.all.map((d) => d.name)).size).toBe(reg.all.length);
    expect(reg.byName.get('customer_lifetime_value_minor')?.dtype).toBe('long');
    // Money feature carries a sibling currency (§1.2).
    expect(reg.byName.get('customer_lifetime_value_minor')?.currency).toBe('INR');
  });

  it('flags PII features so they can be reconciled against the shred manifest', async () => {
    const reg = await loadFeatureRegistryFrom(createFsFeatureSource(FEATURES_DIR), parseFlatFeatureYaml);
    expect(reg.piiFeatureNames).toContain('customer_email_domain');
    // Non-PII features are NOT in the shred set.
    expect(reg.piiFeatureNames).not.toContain('campaign_roas');
  });

  it('rejects a duplicate feature name', () => {
    const raw = 'name: dup\nentity: customer\ndtype: long\nsource: metric:orders\nfreshness_sla: daily\nowner: t\npii: false\n';
    expect(() => loadFeatureRegistry([doc('a.yaml', raw), doc('b.yaml', raw)], parseFlatFeatureYaml)).toThrow(
      FeatureDefinitionError,
    );
  });

  it('rejects an invalid entity/dtype/missing field', () => {
    expect(() => validateFeatureDefinition({ name: 'x', entity: 'nope', dtype: 'long', source: 'm:o', freshness_sla: 'd', owner: 't', pii: false }, 's')).toThrow(FeatureDefinitionError);
    expect(() => validateFeatureDefinition({ name: 'x', entity: 'customer', dtype: 'blob', source: 'm:o', freshness_sla: 'd', owner: 't', pii: false }, 's')).toThrow(FeatureDefinitionError);
    expect(() => validateFeatureDefinition({ name: 'x', entity: 'customer', dtype: 'long', source: 'm:o', freshness_sla: 'd', owner: 't' }, 's')).toThrow(FeatureDefinitionError);
  });

  it('the flat parser refuses nested/list YAML (schema error, not silent)', () => {
    expect(() => parseFlatFeatureYaml('name: x\nnested:\n  a: 1\n', 's')).toThrow();
  });

  it('schema guards + online key template', () => {
    expect(isFeatureEntityType('campaign')).toBe(true);
    expect(isFeatureEntityType('order')).toBe(false);
    expect(isFeatureDtype('vector')).toBe(true);
    expect(onlineFeatureKeyTemplate('customer')).toBe('{brand_id}:feat:customer:{entity_id}');
  });

  it('DEFERRED compute entrypoints fail by design (NotImplemented)', () => {
    expect(() => resolveAsOfFeatures({ brandId: 'b', entityType: 'customer', entityIds: ['e'], featureNames: ['f'], asOf: '2026-01-01T00:00:00Z' })).toThrow(
      FeatureLayerNotImplementedError,
    );
    expect(() => materializeOnline([])).toThrow(FeatureLayerNotImplementedError);
    expect(() => materializeOffline()).toThrow(FeatureLayerNotImplementedError);
  });
});
