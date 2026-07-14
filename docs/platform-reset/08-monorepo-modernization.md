# 08 — Monorepo Modernization Audit

**Scope:** READ-ONLY Staff-Engineer scan of the Brain monorepo for naming-convention
violations, stale/legacy markers, dead code, and unused dependencies.
**Date:** 2026-07-14 · **Branch:** `release` · **Method:** ripgrep / find / git-ls-files sampling.
**Tracked files:** 2,983 · **Non-test TS/TSX:** 1,046 · **DuckDB transform py:** 104.

> **Headline:** This repo is in *good* structural health. The single largest debt category is
> **documentation / naming drift left behind by the Spark→DuckDB transform cutover** — not code
> rot. Code-level naming is internally consistent (Python 100% snake_case, package dirs 100%
> kebab-case, all packages `@brain/*`), commented-out code is effectively zero, and dead-code
> tooling (knip) already exists. The work here is mostly *reconcile the docs to reality* plus a
> few small hygiene fixes and turning existing lint/CI gates from advisory into enforcing.

---

## Category 1 — Naming-convention deviations

**Standard:** files/folders kebab-case · vars/functions camelCase · classes/interfaces/enums
PascalCase · constants UPPER_SNAKE_CASE · db snake_case.

| Dimension | Result | Verdict |
|---|---|---|
| Python file names (`db/iceberg/duckdb/**`, `tools/**`) | **0** non-snake_case | ✅ conforms |
| `packages/*` directory names (37 pkgs) | **0** non-kebab | ✅ conforms |
| `package.json` `name` fields | all `@brain/<kebab>` | ✅ conforms |
| DB objects (migrations, marts) | snake_case throughout | ✅ conforms |
| TS/TSX **file** names | **262** non-kebab (of 1,046 non-test) | ⚠️ deliberate DDD deviation |

The 262 non-kebab TS filenames break down as:

- **169 PascalCase** files (48 of them `.test`/`.spec`) — one-class-per-file DDD convention:
  `PixelInstallation.ts`, `PgPixelStatusRepository.ts`, `ErasureEventPublisher.ts`,
  `ActivateAdAccountCommand.ts`, `IPixelInstallationRepository.ts`. This is the standard
  NestJS/DDD "filename mirrors the exported class" pattern and is applied **consistently** across
  `apps/core/src/modules/**`. It contradicts the kebab-case-files rule but is internally coherent.
- **26 camelCase** route/helper files — `oauthRoutes.ts`, `pixelRoutes.ts`, `readRoutes.ts`,
  `backfillSyncRoutes.ts`, `healthSafety.ts`, `registerConnectors.ts`.
- **6 leading-underscore** private modules — `_attribution-credit.ts`, `_bronze-source.ts`,
  `_pixel-events.ts` (a `_`-prefix "internal, not the barrel export" convention).

**Recommendation:** *ratify, don't churn.* Amend the standard to explicitly permit
PascalCase-file = one-exported-class (DDD) and `_`-prefix = internal module. Only the 26
camelCase route files are genuinely off-pattern (kebab `oauth-routes.ts` would conform); a
rename is low-value churn against a lot of import sites — treat as optional.

---

## Category 2 — Stale / legacy markers (v1–v3, temp, old, backup, deprecated, copy)

**`V4` is the OFFICIAL current architecture name and was NOT flagged.** Genuine leftovers found:

| Marker | Where | Assessment |
|---|---|---|
| `docs/v3-build-log.md`, `docs/v3-section-h-proof-map.md` | docs/ | Historical logs — **keep** (audit trail) or move to `docs/archive/`. |
| `prompts/copilot/system.v1.md`, `knowledge-base/models/splink-v1.md`, `.../reactivation-nudge.v1.yaml`, `db/iceberg/duckdb/silver/splink_v1_golden_eval.py` | assorted | `v1` = *content/model versioning*, not stale. **Keep.** |
| `packages/contracts/src/api/*.api.v1.ts` (~20 files) | contracts | Legit **API** versioning — matches the `/api/v1` route contract. **Keep.** |
| `infra/helm/neo4j-backup/**`, `infra/terraform/modules/neo4j-backup/**` | infra | "backup" = a *function* (Neo4j backup job), not a stale copy. **Keep.** |
| `.orig` / `.bak` / `.rej` / `~` / tracked `__pycache__`/`.pyc` | — | **0 found.** ✅ clean. |
| `temp` / `_old` / `-copy` / `dummy` / `deprecated` in real file names | — | **0 genuine.** ✅ clean. |

**Net: essentially no stale-file debt.** The one real item is the two historical `v3-*` docs at
the docs root, which are noise but harmless.

### 2b — Cutover residue (the real debt in this category)

The Spark→DuckDB transform cutover left **naming/comment residue** that now misleads:

- `infra/helm/cronworkflows/values.yaml` still names the value block **`sparkV4:`** and its
  comments reference deleted templates **`spark-v4.yaml` / `spark-bronze.yaml`** — the actual
  templates are `v4-transform.yaml` / `bronze-maintenance.yaml`. (The chart header candidly
  notes the block name is kept "for values compatibility, one image, minimal diff.")
- `tools/dev/v4-transform.yaml` and `bronze-maintenance.yaml` comments also cite the old
  `spark-*.yaml` names.

---

## Category 3 — Documentation ↔ reality drift (HIGHEST-VALUE finding)

The tracked transform tier is now **DuckDB-on-Iceberg** (`db/iceberg/duckdb/**`, 104 py files);
the Spark tree is **gone from git** (`git ls-files db/iceberg/spark/*` → 0). The blocking CI gate
`tools/lint/v4-naming-guard.sh` **R6** already enforces "Spark tree DELETED, transform is DuckDB."
But the authoritative prose has not caught up:

1. **`CLAUDE.md` / `claude.md`** still assert *"Compute is Spark-on-Iceberg, and Spark is the
   sole TRANSFORM compute."* This directly contradicts the shipped DuckDB tier and the guard's R6.
2. **`CLAUDE.md` cites `tools/dev/v4-refresh-loop.sh` as the refresh entrypoint — that file does
   NOT exist.** The real script is `tools/dev/duckdb-refresh.sh`. (Broken reference in the
   project's own operating manual.)
3. **`v4-naming-guard.sh`'s own top comment block is self-inconsistent:** it says "Compute is
   Spark-on-Iceberg" and describes "StarRocks async MVs" as the serving path, while R1/R5/R6 in
   the *same file* enforce that StarRocks is fully removed (Trino serving) and Spark is deleted
   (DuckDB transform). The rules are correct; the doc header is stale.
4. **`CLAUDE.md` / `claude.md` are byte-identical duplicates.** Only `claude.md` (lowercase) is
   tracked by git; the on-disk `CLAUDE.md` is a case-shadow on macOS's case-insensitive FS. This
   is a real hazard: an edit to one silently masks the other, and cross-platform checkouts can
   diverge.

This drift is the crux of the modernization: **the code and CI gates already reflect the modern
(DuckDB + Trino) architecture; the human-facing docs still describe the retired (Spark +
StarRocks) one.**

---

## Category 4 — Dead code, commented-out blocks, TODOs

| Signal | Count | Notes |
|---|---|---|
| Genuine `TODO`/`FIXME`/`HACK` in code | **~5** | e.g. `tools/privacy/src/rtbf-drill.ts`, one `logistics-status` test, one demo e2e. Trivially low. |
| `XXX` "markers" | 0 real | All ~150 hits are placeholder/mask patterns (`xxxx`, redaction), not code markers. |
| Commented-out **code** lines (`// const/if/return/import…`) | **9** | Most are in `tools/eslint-rules/fixtures/*` (intentional bad examples) or explanatory `// return …` prose. Effectively zero. |
| `@ts-ignore` / `@ts-nocheck` / `@ts-expect-error` | **4** | Very low. |
| `eslint-disable` directives | **44** | **35** are `@typescript-eslint/no-explicit-any`; rest are PCI/redis-key/react-hooks one-offs. Real but low-severity type-safety debt. |

**Verdict:** dead-code and commented-out-code debt is negligible. The only actionable item is the
35 `no-explicit-any` suppressions (concentrated, tractable to burn down).

---

## Category 5 — Unused dependencies / dead exports

- **knip is already configured** (`knip.jsonc`, well-tuned with documented `ignoreDependencies`
  for dynamic imports like `@aws-sdk/client-kms`/`-ses`, `tsx`, `prettier`) and runs in CI
  (`.github/workflows/knip.yml`).
- **BUT it is `continue-on-error` / report-only — it never gates a merge.** Unused files,
  exports, and deps can accumulate silently; the workflow comment itself says "Promote to a
  blocking gate later once the baseline is clean."
- knip is a CI-resolved devDep and is **not installed in a fresh local checkout**, so a live
  unused-dep list could not be produced in this read-only pass. The mechanism exists; the
  *enforcement* does not.

---

## Category 6 — Tracked scaffolding / doc bloat (minor)

- **`.engineering-os/` — 343 tracked files**, largest non-code tracked artifact; last touched
  **2026-06-22** (>3 weeks stale). Appears to be an assistant/workflow scaffolding tree
  (`context-sync/`, `decision-log/`, `usage.jsonl` 32 KB, `foundation-approved.2026-06-15/`).
  Candidate for archival or `.gitignore` if it's generated/ephemeral.
- `docs/` has 26 entries with several loose top-level audit `.md` files (`db-audit-*.md`,
  `v3-*.md`, `eos-reconciliation-*.md`) — organizational tidiness, not debt.

---

## Prioritized cleanup backlog

| # | Item | Risk | Effort | Value |
|---|------|------|--------|-------|
| 1 | **Reconcile `CLAUDE.md`/`claude.md` to DuckDB+Trino reality** — replace "Spark is the sole TRANSFORM compute" with the DuckDB-on-Iceberg statement; fix the `v4-refresh-loop.sh` → `duckdb-refresh.sh` reference. | Low | S | **High** — the operating manual currently misdescribes the platform. |
| 2 | **De-duplicate `CLAUDE.md`/`claude.md`** — pick one canonical file, delete the case-shadow, add a CI guard against case-only-duplicate paths. | Low | S | **High** — silent-mask + cross-platform hazard. |
| 3 | **Fix `v4-naming-guard.sh` header comment** to match its own R1/R5/R6 rules (DuckDB transform, Trino serving; drop "Spark-on-Iceberg"/"StarRocks MVs" prose). | Low | S | **High** — the gate documents the *old* arch while enforcing the new one. |
| 4 | **Rename cutover residue** — `sparkV4:` → `transformV4:` in `cronworkflows/values.yaml`; fix `spark-v4.yaml`/`spark-bronze.yaml` comment refs to the real template names. | Low–Med (Helm values key rename touches templates) | M | Med — removes the most misleading gitops naming. |
| 5 | **Promote knip from report-only to blocking** once baseline is clean (drop `continue-on-error`). | Med (may surface a backlog) | M | **High** — turns existing tooling into an actual gate. |
| 6 | Burn down the **35 `no-explicit-any`** eslint-disables (or ratify the unavoidable ones with a comment). | Low | M | Med — type-safety hygiene. |
| 7 | Archive/`.gitignore` **`.engineering-os/`** (343 stale files) if generated/ephemeral. | Low | S | Med — de-clutters the tree. |
| 8 | Move `docs/v3-*.md` and loose `docs/*-audit-*.md` into `docs/archive/`. | Low | S | Low — tidiness. |
| 9 | *(Optional)* Ratify the DDD PascalCase-file + `_`-prefix conventions in the standard; optionally rename the 26 camelCase `*Routes.ts` files to kebab. | Low | M (26 files + imports) | Low — cosmetic. |

---

## Proposed enforcement plan

1. **Amend the naming standard** (in `CLAUDE.md` and the linter docs) to codify the *actual*
   conventions: kebab-case for files EXCEPT (a) one-exported-class files may be PascalCase (DDD),
   (b) `_`-prefixed internal modules are allowed. This removes 175 false "violations" and makes
   the remaining 26 camelCase route files genuinely off-pattern and lint-targetable.
2. **Add an ESLint filename rule** (e.g. `unicorn/filename-case` with a `case: ['kebabCase','pascalCase']`
   allowance) scoped to `apps/**`/`packages/**` src, so new files must conform to the ratified set.
3. **Add a "case-only duplicate path" CI check** (one-liner: `git ls-files | tr A-Z a-z | sort | uniq -d`)
   to prevent `CLAUDE.md`/`claude.md`-style shadows on case-insensitive filesystems.
4. **Extend `v4-naming-guard.sh`** (or a doc-lint step) with a small grep asserting that
   `CLAUDE.md` does NOT contain "sole TRANSFORM compute" tied to Spark and that any script path it
   cites (`tools/dev/*.sh`) actually exists — catch operating-manual drift automatically.
5. **Promote knip to blocking** (`.github/workflows/knip.yml`) after a one-time baseline cleanup,
   converting the existing advisory dead-code report into a merge gate.
6. **Keep the existing gates** (v4-naming-guard blocking, log-grep, boundary lint, PCI/redis-key
   custom rules) — they are well-designed; the gap is *doc drift* and *advisory-only knip*, not
   missing tooling.

---

## What is already sound (do NOT "fix")

- Python (snake_case), package dirs (kebab), package names (`@brain/*`), DB objects (snake_case):
  100% conforming.
- Commented-out code, `.orig`/`.bak`, tracked `.pyc`: effectively zero.
- DDD PascalCase-file convention: a deliberate, consistent choice — ratify, don't rename.
- Architecture invariants ARE machine-enforced (`v4-naming-guard.sh` R1–R6 blocking; knip
  configured). The modern DuckDB/Trino design is correctly reflected in *code and gates*.
