// SPEC: E
/**
 * @brain/ai-features — infrastructure adapter: a MINIMAL flat-YAML parser (YamlParsePort).
 *
 * Scope-limited on purpose: feature declarations are a FLAT `key: value` mapping (the
 * {name, entity, dtype, source, freshness_sla, owner, pii, currency, description} shape). This
 * parser supports exactly that subset — top-level scalar keys, `#` comments, blank lines,
 * quoted or bare scalars, and `true`/`false` → boolean. It intentionally does NOT support
 * nesting, lists, or anchors: a declaration that needs them is a schema error, not a parser gap.
 *
 * Rationale (scaffold-only): keeps the package dependency-free (no `yaml`/`js-yaml`) so the
 * skeleton typechecks and tests offline. When the Wave-E compiler is built, swap this adapter
 * for a full YAML library behind the same YamlParsePort — nothing else changes.
 */

import type { YamlParsePort } from '../loader.js';

function coerce(scalar: string): unknown {
  const s = scalar.trim();
  if (s === 'true') return true;
  if (s === 'false') return false;
  if (
    (s.startsWith('"') && s.endsWith('"') && s.length >= 2) ||
    (s.startsWith("'") && s.endsWith("'") && s.length >= 2)
  ) {
    return s.slice(1, -1);
  }
  return s;
}

/** Parse one flat feature YAML document into a plain object. Throws on nesting/lists. */
export const parseFlatFeatureYaml: YamlParsePort = (raw: string, source: string): unknown => {
  const out: Record<string, unknown> = {};
  const lines = raw.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? '';
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#') || trimmed === '---') continue;
    if (line.startsWith(' ') || line.startsWith('\t') || trimmed.startsWith('-')) {
      throw new Error(`[ai-features] ${source}: line ${i + 1}: nested/list YAML is not supported by the flat parser`);
    }
    const colon = line.indexOf(':');
    if (colon < 0) {
      throw new Error(`[ai-features] ${source}: line ${i + 1}: expected "key: value"`);
    }
    const key = line.slice(0, colon).trim();
    let valuePart = line.slice(colon + 1);
    const hash = valuePart.indexOf(' #');
    if (hash >= 0) valuePart = valuePart.slice(0, hash);
    out[key] = coerce(valuePart);
  }
  return out;
};
