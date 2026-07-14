# 09 — Engineering Standards (Naming · IaC · Review)

**Author:** Engineering Program Lead · **Date:** 2026-07-14
**Account:** 380254378136 (PAID PRODUCTION) · **Region:** ap-south-1 · **Domain:** brain.pipadacapital.com
**Inputs:** `04-architecture-review.md`, `06-redesign-proposal.md`, `07-cost-optimization.md`,
`08-monorepo-modernization.md`, ADR-0001…0005 (this program), the existing `docs/adr/*`, and
`tools/lint/v4-naming-guard.sh`.

> **Purpose.** Capture the naming, Infrastructure-as-Code, and review standards to *enforce* going
> forward. These codify what is already largely true (the monorepo audit `08` found the repo in good
> structural health) and turn advisory gates into enforcing ones. **Ratify, don't churn** — where an
> existing convention is coherent (DDD PascalCase files, `V4` architecture name), the standard adopts
> it rather than renaming en masse.

---

## 1. Naming standards

### 1.1 Code

| Dimension | Rule | Status in repo (`08`) |
|---|---|---|
| Files / folders | **kebab-case**, EXCEPT the two ratified exceptions below | packages/dirs 100% conform |
| One-exported-class files (DDD) | **PascalCase** filename mirrors the exported class (`PixelInstallation.ts`) — RATIFIED | consistent across `apps/core/src/modules/**` |
| Internal (non-barrel) modules | **`_`-prefix** (`_attribution-credit.ts`) — RATIFIED | consistent |
| Route/helper files | kebab-case (`oauth-routes.ts`); the 26 legacy camelCase `*Routes.ts` are the only genuinely off-pattern files — rename opportunistically, not in bulk | 26 remain |
| Variables / functions | **camelCase** | conforms |
| Classes / interfaces / enums | **PascalCase** | conforms |
| Constants | **UPPER_SNAKE_CASE** | conforms |
| Python files | **snake_case** (`db/iceberg/duckdb/**`, `tools/**`) | 100% conform |
| DB objects (tables, columns, marts, migrations) | **snake_case** | 100% conform |
| Package names | **`@brain/<kebab>`** | 100% conform |

**Enforcement:** add an ESLint `unicorn/filename-case` rule scoped to `apps/**`/`packages/**` src
with `case: ['kebabCase', 'pascalCase']` (allows the ratified DDD exception) + a `_`-prefix ignore.

### 1.2 Cloud resources

- **Pattern:** `brain-<env>-<component>[-<qualifier>]` (e.g. `brain-prod-postgres`,
  `brain-prod-system-al2023`). Buckets: `brain-<purpose>-<env>-<account-id>`. Already consistent
  across the inventory.
- **`V4` is the official architecture name** — never flag it as a stale version marker. `v1`/`v2` on
  *content* (models, API contracts `*.api.v1.ts`, prompts) is legitimate content-versioning — keep.

### 1.3 Mandatory cost-allocation + isolation tags (billable resources)

Every billable AWS resource created by Terraform MUST carry:
`env=prod` · `app=brain` · `component={eks|aurora|redis|kafka|trino|duckdb|collector|bff|web|…}` ·
and, where attributable, the tenant `brand_id`. Activate these as **cost-allocation tags** in
Billing and tag Karpenter NodePools → component so per-workload compute cost is attributable
(`07` FinOps). `brand_id`-first tenant isolation is a Brain invariant on every row/event/key.

---

## 2. Infrastructure-as-Code standards

1. **Terraform is authoritative for the AWS-native estate.** No console-only ("ClickOps") changes to
   Brain resources — they drift and are lost on the next apply. State lives in `brain-tfstate-prod`
   S3 + `brain-tfstate-lock-prod` DynamoDB + dedicated CMK; never delete these while IaC is live.
2. **Modules + `envs/prod` layout stays.** New infra is a module + an `envs/prod` call, reviewed via
   PR. Keep the module/env split (`infra/terraform/{modules,envs/prod}`).
3. **GitOps for cluster state via ArgoCD app-of-apps** with `prune + selfHeal + ServerSideApply`.
   Helm values are the source of truth; no `kubectl edit` in prod (self-heal reverts it anyway).
4. **Deploy path (RELEASE-LAYER, per CLAUDE.md):** feature → PR → `release`. NO CI on feature or
   feature→release merges. ALL checks (pr/integration/infra/knip) run once on the **release→master
   promotion PR**. **Only the repo owner** merges `release`→`master` (= production); that merge fires
   `deploy.yml` + the infra TF lane, and ArgoCD prod tracks `master`. Never open/merge a PR to
   `master` directly.
5. **Every change is small, reversible, and `git revert`-able.** Additive-with-rollback for anything
   touching the medallion, catalog, or serving path (ADR-0002). No `terraform destroy` on the prod
   account (ADR-0001).
6. **Secrets via External Secrets Operator + KMS CMK hierarchy** (root / connector / audit /
   tfstate). No secrets in git, in Helm values, or in container images. App/JWT/connector secrets
   get a rotation schedule (ADR-0004, SEC-2).
7. **Reversibility-by-a-flag is a design requirement** for cost/reliability tradeoffs
   (`enable_nat_gateway`, `enable_cross_region_replication`, `eks_support_type`) — each with a
   documented ADR graduation trigger.

### 2.1 Protect the banked wins (CI/IaC plan-guards)

The structural cost wins are easy to regress. Extend the existing `eks_support_type=STANDARD`
plan-guard with equivalent **blocking** guards/alerts for:

- accidental **managed-NAT-gateway** creation (must stay fck-nat + endpoints),
- **Aurora min-ACU** drifting **above** the 0.5 floor / max-ACU unbounded,
- **Kafka rack-awareness** config regression (the ~$194/mo cross-AZ lever),
- any **new StarRocks** coupling in serving app code (already guarded — keep),
- untagged billable resources (fail the apply).

---

## 3. Review standards

### 3.1 Architecture / PR review checklist (from CLAUDE.md, enforced)

- Is the architecture aligned with Brain's purpose (Capture Truth → Build Trust → Enable Decisions)?
- Does the database support the flow **without unnecessary redesign**?
- Does the UI build trust before insight (no empty charts as a success state)?
- Does the system **fail safely**? Can data be **replayed, backfilled, deduplicated, retried**?
- Are **confidence and freshness** measurable?
- Is **tenant isolation** (`brand_id`-first + `${BRAND_PREDICATE}` seam) preserved?
- **Bronze is the source of truth; no event loss.** Money is bigint minor units + `currency_code`
  (never a float, never blended).
- Are there **tests for the behavior change** (CLAUDE.md operating standard)?

### 3.2 Serving-path fragility rules (from incident history)

- Trino serving reads go **only** through `brain_serving.mv_*` views + the Valkey cache — never a
  bare `brain_gold.`/`brain_silver.` DB, never StarRocks (removed).
- Respect the Trino SQL dialect (typed/tz literals, `from_iso8601_timestamp`, BigInt-safe
  serialization) — the two documented type-drift classes must not regress.
- No `brand_id` as a raw Prometheus metric label (cardinality + isolation trap).

### 3.3 Documentation-must-match-reality (the `08` finding)

The biggest debt in the repo is **doc↔reality drift** from the Spark→DuckDB cutover, not code rot.
Enforce:

- `CLAUDE.md`/`claude.md` must describe the **shipped** architecture (**DuckDB-on-Iceberg** transform,
  **Trino** serving) — not the retired "Spark is the sole TRANSFORM compute" / "StarRocks MVs" prose.
- Any `tools/dev/*.sh` path a doc cites must **exist** (fix `v4-refresh-loop.sh` → `duckdb-refresh.sh`).
- De-duplicate the `CLAUDE.md`/`claude.md` case-shadow; add a **case-only-duplicate-path CI check**
  (`git ls-files | tr A-Z a-z | sort | uniq -d`).
- Fix the stale `v4-naming-guard.sh` header comment to match its own R1/R5/R6 rules.
- Every consequential decision gets an **ADR** (Title, Status, Context, Decision, Alternatives,
  Consequences, Rollback) under `docs/adr/` (numbered) or `docs/platform-reset/adr/` (program-scoped).

### 3.4 Turn advisory gates into enforcing gates

| Gate | Today | Target |
|---|---|---|
| `v4-naming-guard.sh` (retired-DB/dbt/feature-precompute/StarRocks) | **blocking** ✅ | keep; fix header prose |
| knip (unused files/exports/deps) | report-only (`continue-on-error`) | **blocking** after one baseline cleanup |
| ESLint filename-case | absent | add (ratified kebab + PascalCase-DDD) |
| Case-only duplicate path | absent | add one-liner CI check |
| Doc-drift grep (CLAUDE.md ↔ shipped arch, cited script paths exist) | absent | add to `v4-naming-guard.sh` / doc-lint |
| Cost plan-guards (§2.1) | partial (EKS support only) | extend to NAT/ACU/rack-awareness/tags |
| `no-explicit-any` suppressions | 35 disables | burn down or ratify-with-comment |

---

## 4. Operating standards (carry-over, non-negotiable)

Prefer small, reversible, auditable changes · treat integrations as unreliable · preserve tenant
isolation · support replay/backfill/dedup/retries · respect regional residency and privacy (ADR-0005)
· add tests for any behavior change · verify with logs, metrics, or reproducible evidence.
