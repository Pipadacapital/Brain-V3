# Pass 2: Repository Structure Audit (repo-structure)

## Board Verdict

The Brain V3 monorepo has a sound high-level structure — pnpm workspaces, Turbo build graph, and CODEOWNERS are all present and correctly scoped. Cross-deployable coupling is absent (no app imports another app). The modular-monolith intent is architecturally sound and the bounded-context module layout in `apps/core/src/modules/` follows the declared pattern. However, the single most important finding is that the ESLint boundary rule protecting `@brain/metric-engine` (`I-ST03 / D-6`) is structurally inert: the element-type ordering in `eslint.config.mjs` causes every file in `apps/core/**` to be classified as type `app` before `core-module`, so the `core-module → metric-engine` restriction never fires. Nine production source files in four bounded contexts (`ai`, `attribution`, `data-quality`, `frontend-api`) import the metric-engine directly in violation of the stated fence, and CI has been silently green throughout. Additionally, `@brain/metric-engine` carries `mysql2` as a phantom production dependency (never actually imported), `apps/core/package.json` declares `@brain/config` but never imports it, the attribution bounded-context has a hard cross-module coupling to the analytics module at its public API boundary, and the collector deployable is pinned to Fastify v4 while core runs Fastify v5.

**Severity counts:** High: 1 | Medium: 3 | Low: 1

---

## Finding RS-1

**Title:** ESLint boundary rule for `@brain/metric-engine` is structurally inert — nine production files bypass the fence undetected

**Severity:** High

**Category:** Layering Violation / Boundary Enforcement

**Evidence:**
- `eslint.config.mjs:54-99` — element types declared in order: `app` (pattern `apps/*`), then `core-module` (pattern `apps/core/src/modules/*`).
- `eslint.config.mjs:90-96` — the metric-engine fence restricts element type `core-module` (`module: '!(measurement|analytics)'`), permitting only `measurement` and `analytics`.
- `node_modules/.pnpm/@boundaries+elements@1.2.0_eslint@9.39.4/node_modules/@boundaries/elements/dist/index.js` — `_fileDescriptorMatch` expands pattern `apps/*` to `apps/*/**/*` in FOLDER mode. First-match-wins: for any file in `apps/core/src/modules/**`, `apps/*/**/*` matches before `apps/core/src/modules/*/**/*`, classifying all files as type `app`, never `core-module`. The metric-engine fence targeting `core-module` never evaluates.
- Confirmed by running `npx eslint apps/core/src/modules/attribution/internal/credit-writer.ts --format=json`: 0 errors, 0 warnings.
- Production violations (all non-test source files):
  - `apps/core/src/modules/ai/internal/ask-brain.ts:25-26` — imports `EngineDeps`, `MetricId`, `MetricVersion`, `ResolverClient` from metric-engine.
  - `apps/core/src/modules/ai/nlq/resolve-question.ts:24` — imports `resolveMetric` from metric-engine.
  - `apps/core/src/modules/ai/prompt-registry/resolver-prompt.ts:13` — imports `METRIC_REGISTRY` from metric-engine.
  - `apps/core/src/modules/ai/provenance/ai-provenance.dto.ts:10` — imports metric-engine types.
  - `apps/core/src/modules/ai/provenance/ai-provenance.repository.ts:17` — imports `withBrandTxn` from metric-engine.
  - `apps/core/src/modules/attribution/internal/credit-writer.ts:34-35` — imports `withSilverBrand`, `BRAND_PREDICATE` from metric-engine.
  - `apps/core/src/modules/data-quality/internal/application/queries/get-data-quality-summary.ts:33-43` — imports `withBrandTxn`, `computeCostConfidence`, `evaluateGate` etc. from metric-engine.
  - `apps/core/src/modules/data-quality/internal/application/queries/get-metric-trust.ts:14-15` — imports `EngineDeps`, `evaluateGate` from metric-engine.
  - `apps/core/src/modules/frontend-api/internal/bff.routes.ts:79-82` — imports `AttributionModelId`, `AdPlatform`, `TimeGrain`, `SilverPool` from metric-engine.

**Impact:** The stated invariant `I-ST03 / D-6` ("metric-engine is fenced to measurement and analytics modules only") is not enforced at CI. Any bounded context can import metric-engine without detection. A future developer adding a direct metric-engine call in the connector or workspace-access module will receive no warning. Dependency scope creep is already underway (9 files, 4 modules).

**Root Cause:** In `eslint-plugin-boundaries`, element descriptors are matched first-to-last. Pattern `apps/*` (type `app`) is defined at line 56, before `apps/core/src/modules/*` (type `core-module`) at line 58. Because the plugin expands folder-mode patterns to `<pattern>/**/*`, `apps/*/**/*` matches all files under `apps/core/` on the same loop iteration as `apps/core/src/modules/*/**/*`, but `app` is checked first and wins. No resolver misconfiguration was needed; the ordering alone kills the rule.

**Fix:** Reorder element descriptors so `core-module` (the more specific pattern) precedes `app`, or make `app` pattern a file-mode match against `apps/*/src/main.ts` (entry points only), not a folder-mode glob over all app source. Alternatively, remove the `app` element type if it serves no active rule, and keep only `core-module` for intra-core enforcement. Verify by running `npx eslint apps/core/src/modules/attribution/internal/credit-writer.ts` and expecting a boundaries error.

**Priority:** P1

**Tenant Impact:** Multi-tenant. If a future code path bypasses the metric-engine seam's brand predicate isolation (injected in `withBrandTxn` / `withSilverBrand`), cross-tenant data leakage is possible. The fence was designed to prevent exactly this. Its current inertness removes the enforcement backstop.

**Detection:** Silently absent from CI. No alert fires. The only detection is code review noticing a new `@brain/metric-engine` import in a non-analytics/measurement module.

---

## Finding RS-2

**Title:** `@brain/metric-engine` carries `mysql2` as a phantom production dependency (never imported)

**Severity:** Medium

**Category:** Dependency Graph / Package Boundary

**Evidence:**
- `packages/metric-engine/package.json:14-16` — `"dependencies": { "@brain/money": "workspace:*", "mysql2": "^3.22.5" }`.
- `packages/metric-engine/src/silver-deps.ts:37-38` — comment explicitly states: "rather than importing mysql2 types into the engine's public surface, we type it structurally (SilverPool interface)".
- Full grep of `packages/metric-engine/src/**` for `from 'mysql2'` or `import.*mysql2` returns zero results. mysql2 appears only in comments and JSDoc.
- `packages/metric-engine/package.json:19-22` — `pg` is correctly in devDependencies; mysql2 was accidentally promoted to production dependencies.

**Impact:** Every downstream consumer of `@brain/metric-engine` (currently `apps/core`, `apps/stream-worker`, `packages/ai-gateway-client`, `tools/isolation-fuzz`) installs mysql2 as a transitive production dependency unnecessarily. This is an unnecessary 3MB+ native addon compiled on install. More importantly it misrepresents the package's actual I/O surface — the package is correctly designed to be a pure library with structural pool types, but the package.json claims a database driver dependency it doesn't use.

**Root Cause:** When the StarRocks/Silver seam was introduced, the developer declared mysql2 as a dependency by habit (mirroring how pg is used in stream-worker), then correctly switched to structural typing (SilverPool interface) but did not remove the now-unused package.json entry.

**Fix:** Move `mysql2` from `dependencies` to `devDependencies` in `packages/metric-engine/package.json`, or remove it entirely if no test file imports it directly (confirmed: no test imports `from 'mysql2'` in this package). Run `pnpm install` and verify the package still builds and tests pass.

**Priority:** P2

**Tenant Impact:** No direct tenant data risk. Installation and bundle size impact only.

**Detection:** Surfaces as unused dependency in depcheck or `pnpm ls --depth=1` output. No runtime alert.

---

## Finding RS-3

**Title:** `apps/core/package.json` declares `@brain/config` workspace dependency that is never imported in any source file

**Severity:** Medium

**Category:** Dependency Graph / Package Boundary

**Evidence:**
- `apps/core/package.json:19` — `"@brain/config": "workspace:*"` listed in `dependencies`.
- Grep of `apps/core/src/**` for `from '@brain/config'` returns zero results. Verified: no source file in the core app imports anything from `@brain/config`.
- `apps/collector/src/main.ts:21` — `@brain/config` IS used here: `import { parseEnv, CollectorEnvSchema } from '@brain/config'`. The core app has its own inline env parsing with no config package usage.

**Impact:** The phantom dependency inflates the core app's install footprint and creates a false signal in the dependency graph that `@brain/config` is coupled to the core service. When `@brain/config` changes (e.g. adding a breaking schema change), it will trigger a Turbo rebuild of `apps/core` unnecessarily.

**Root Cause:** Likely copy-paste when setting up the core package.json, intending to add it for future use, then the core app implemented its own env handling inline.

**Fix:** Remove `"@brain/config": "workspace:*"` from `apps/core/package.json` dependencies. Run `pnpm install` and verify `apps/core` still builds.

**Priority:** P2

**Tenant Impact:** No direct tenant data risk. Build-time overhead only.

**Detection:** Surfaced by `depcheck` or `pnpm ls --filter=@brain/core --depth=1`. No runtime alert.

---

## Finding RS-4

**Title:** `attribution/index.ts` imports from `analytics/index.ts` — cross bounded-context coupling at the module's public boundary

**Severity:** Medium

**Category:** Module Ownership / Cross-Boundary Reference

**Evidence:**
- `apps/core/src/modules/attribution/index.ts:21-30` — explicit imports of `getJourneyFirstTouchMix`, `getJourneyStitchRate`, `getJourneyTimeline` and their return types from `'../analytics/index.js'`.
- `apps/core/src/modules/attribution/index.ts:60-64` — re-exports these as `journeyReads` in attribution's public API.
- The same file's comment (line 14-18) acknowledges: "the analytics sole-read-path use-cases" own the journey reads. The attribution module effectively re-exports analytics functions under an attribution namespace.
- The ESLint `no-restricted-imports` rule blocks reach-around into `/internal/` but does NOT block cross-module index-to-index imports. This coupling is invisible to current lint rules.

**Impact:** Attribution and analytics are defined as separate bounded contexts in the architecture docs (recon map). This import means that attribution cannot be extracted, independently tested, or versioned without pulling in the analytics module. Any breaking change to analytics journey APIs automatically breaks attribution's public surface. The `journeyReads` facade in attribution adds no value over the analytics index itself — callers could import from analytics directly — yet creates a maintenance obligation.

**Root Cause:** The journey reads were placed in the analytics bounded context (correct per `I-ST01` — analytics is the sole read path), but attribution was given "ownership" of the silver touchpoint layer concept. To express that ownership without duplicating the functions, the developer chose to re-export analytics functions through the attribution index. This is an architectural shortcut that introduces unnecessary coupling.

**Fix:** Either (a) remove `journeyReads` from `attribution/index.ts` entirely — callers that need journey reads should import from analytics directly; or (b) if attribution truly needs to own the journey read contract, move the implementation functions into attribution's internal layer and have analytics import/re-export from there (reversing the direction). Option (a) is lower risk.

**Priority:** P2

**Tenant Impact:** No direct tenant data risk. Architectural coupling between bounded contexts.

**Detection:** Visible in static analysis of import graph. No runtime alert.

---

## Finding RS-5

**Title:** Collector deployable uses Fastify v4 while Core uses Fastify v5 (major version split between deployables)

**Severity:** Low

**Category:** Dependency Graph / Version Consistency

**Evidence:**
- `apps/collector/package.json:16` — `"fastify": "^4.28.0"`.
- `apps/core/package.json:36` — `"fastify": "^5.7.2"`.
- No Fastify plugin code is shared across packages (confirmed: zero `@fastify` dependencies in any `packages/` directory). The split is isolated to each deployable.
- Fastify v4→v5 is a major version with breaking changes in plugin registration types, hook signatures, and the `FastifyInstance` generic API.

**Impact:** The collector is currently one major version behind. Any future attempt to share a Fastify plugin utility (e.g. a shared request-id plugin, observability plugin, or rate-limiter helper between collector and core) would require resolving the version split first. Developer onboarding is complicated by two different Fastify APIs to understand. Future security patches in Fastify v5 may not be backported to v4.

**Root Cause:** The collector was likely scaffolded against Fastify v4 (stable at the time) and not upgraded when core adopted v5.

**Fix:** Upgrade `apps/collector` to Fastify v5. Review the collector's Fastify usage (`apps/collector/src/interfaces/rest/*.ts`) against the v4→v5 migration guide (primarily the plugin generics change and the removal of `addContentTypeParser` signature changes). The collector has minimal Fastify surface (4 route files + main.ts) so migration effort is low.

**Priority:** P3

**Tenant Impact:** No direct tenant data risk. Maintenance burden and upgrade risk over time.

**Detection:** Visible in `package.json` diff. No runtime alert unless a v4-only API is used that breaks on v5 at startup.
