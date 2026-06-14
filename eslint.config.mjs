// Flat ESLint config — enforces the modular-monolith boundaries (doc 05 §7).
// The "modular monolith" is only real if the boundaries are mechanically enforced.
import boundaries from 'eslint-plugin-boundaries';

export default [
  {
    files: ['**/*.ts', '**/*.tsx'],
    plugins: { boundaries },
    settings: {
      'boundaries/elements': [
        { type: 'app',     pattern: 'apps/*' },
        { type: 'module',  pattern: 'apps/core/src/modules/*' },
        { type: 'package', pattern: 'packages/*' },
      ],
    },
    rules: {
      // 1. App-to-app imports are banned.
      // 2. A core module may import another module's index.ts ONLY (never its internal/).
      // 3. metric-engine may be imported ONLY by `analytics` and `measurement`.
      // 4. Raw Redis keys are banned — use packages/tenant-context brandKey().
      // 5. No PII in logs (custom rule — enforced hardest on identity).
      // TODO: wire boundaries/element-types + no-restricted-imports per doc 05 §7.
      'boundaries/element-types': ['warn', { default: 'allow', rules: [] }],
    },
  },
];
