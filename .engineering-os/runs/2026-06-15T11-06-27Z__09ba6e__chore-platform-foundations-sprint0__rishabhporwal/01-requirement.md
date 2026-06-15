# Requirement: Brain Platform Foundations (Sprint 0)

| Field | Value |
|-------|-------|
| **req_id** | `chore-platform-foundations-sprint0` |
| **Title** | Brain Platform Foundations (Sprint 0) |
| **Submitted by** | rishabhporwal |
| **Submitted at** | 2026-06-15T11:06:27Z |
| **Tier impact** | n/a (platform foundation; no product packaging tier) |
| **Region impact** | India `ap-south-1` only (Phase 1; RegionAdapter seam built, single binding active) |

---

## Lane *(set by the Engineering Advisor at Stage 1)*

| Field | Value |
|-------|-------|
| **feature_class** | high-stakes |
| **feature_class_rationale** | Deterministic lane scan returned `multi_tenancy` trigger surface (brand_id tenant boundary at every layer); ≥1 surface ⇒ high_stakes (conservative). Also touches IaC/secrets/IAM, CI/CD gates, and the data platform spine. |
| **trigger_surfaces_touched** | multi_tenancy (primary); also implicates: schema/contract parity (contract-first), system-of-record/audit (Bronze immutability), secrets/auth (IAM least-privilege, Secrets Manager) |

---

## Raw text (from the Stakeholder)

> TASK: Implement Brain Platform Foundations (Sprint 0). Brain architecture is frozen. Sprint 0 implementation only — do NOT build business features, attribution, decision engine, customer 360, analytics, or UI features. Only platform foundations.
>
> Implement: (1) Development Standards, (2) CI/CD Foundation, (3) AWS Foundation, (4) Data Platform Foundation. Production-grade, aligned with Brain architecture.
>
> Critical principles: Contract-first (all APIs/events from contracts, no ad-hoc payloads); Infrastructure-as-Code (all infra Terraform-managed, no manual AWS); Everything Observable (logs+metrics+traces day one); Multi-tenant by default (brand_id tenant boundary); Security by default (no secrets in code, no public resources unless required, least-privilege IAM).
>
> PART 1 — Development Standards: Turborepo + pnpm monorepo aligned to approved architecture; ESLint, Prettier, TS strict, Husky, lint-staged, Commitlint, Conventional Commits; Vitest, Playwright, contract-testing framework (run in CI); coding guidelines, naming/folder/package conventions, error-handling standards.
>
> PART 2 — CI/CD Foundation: GitHub Actions pipelines — Validation (lint, typecheck, unit, contract validation, schema-compat) on every PR; Build (all apps + packages, verify dependency graph); Security (dependency, secret, vulnerability scanning); Infrastructure (terraform fmt, validate, plan); branch protection (required checks, review/merge requirements).
>
> PART 3 — AWS Foundation: provision dev/staging/prod; only dev actively used in Phase 1 (staging+prod provisioned but unused, no prod deployments). Account isolation strategy + rationale; VPC, private/public subnets, NAT strategy, security groups; IAM (least privilege, service roles, deployment roles, developer access model); AWS Secrets Manager (no secrets in repos); S3 Bronze bucket, Iceberg storage buckets, Terraform state bucket; CloudWatch alarms + dashboards.
>
> PART 4 — Data Platform Foundation (most important): Pixel → Collector → Redpanda → Iceberg Bronze → StarRocks Silver → StarRocks Gold. Redpanda (local dev + dev env, topic/retention/replay strategy); Iceberg Bronze (immutable SoR, replayability, partitioning, schema evolution); StarRocks Silver+Gold (analytics serving, low-latency, tenant isolation); dbt (project structure, environments, testing, deployment); Data-quality FRAMEWORK only (freshness, completeness, schema validation, reconciliation — no business rules yet); Observability (Grafana, Loki, Prometheus, OpenTelemetry — logs/metrics/traces for every component).
>
> Validation: dev standards enforceable; CI/CD prevents bad merges; AWS reproducible; infra fully Terraform-managed; Redpanda/Iceberg/StarRocks/dbt/observability operational; architecture stays aligned with Brain.

---

## Problem statement

Brain has an approved Product Canon and a frozen architecture (docs 01–12) but no executable platform foundation. Sprint 0 must produce the production-grade substrate — monorepo standards, CI/CD gates, Terraform-managed AWS (dev/staging/prod), and the data-platform spine (Redpanda → Iceberg Bronze → StarRocks → dbt) with observability — so that M1 (the thin vertical data spine) can begin on a sound, isolation-enforced, reproducible base. No business logic.

## Target user

The Brain engineering team (Founder + data-heavy build team). The deliverable is developer-facing platform: the paved path every later builder self-serves on.

## Success metric

Sprint-0 binary exit (doc 12 §"Sprint 0 exit criteria"): (1) `pnpm i && turbo build` green + import-boundary lint enforced; (2) hello-world event flows pixel→collector→Redpanda→Bronze in CI; (3) StarRocks queries a Bronze test table via the Iceberg catalog; (4) contracts codegen → types/OpenAPI/Avro/MCP, breaking change fails CI; (5) RLS on + isolation negative-test passes (brand-A→brand-B = 0 rows/403); (6) secrets via KMS/IRSA + no-PII-log lint active; (7) trace+log with correlation ID in Grafana + SLO alert fires on synthetic breach; (8) CI deploy matrix builds only affected deployables, staging auto-deploys, prod promote + rollback + flag-off verified; (9) parity-oracle test scaffold runs green on a trivial fixture; (10) dev/staging/prod provisioned via Terraform.

## Constraints

- **Architecture is frozen** — no new services/deployables/databases/ledgers/platforms beyond the Canon (3 deployables + web + Argo jobs; managed-first stack).
- **Phase-1 scope only** — single-region India `ap-south-1`; defer all Phase 2/3 reservations; recommend-only; deterministic.
- **Managed-first** per STACK.md (Redpanda Cloud, managed StarRocks, Grafana Cloud, self-hosted Authentik, node-pg-migrate, KafkaJS).
- **Multi-tenant by default** — `brand_id` carried on every row/event/key/log; RLS day-one; isolation negative tests are a P0 launch gate (INVARIANTS.md / TRIGGER-SURFACES.md).
- **Security by default** — KMS + Secrets Manager, least-privilege IAM (IRSA), no secrets in repo, no public resources unless required.
- **Cost-aware** — single region, hourly (not continuous) parity, small CMK set, managed services over self-host (doc 10 §19).

## Non-goals

- No business features, attribution, decision engine, Customer 360, analytics, or UI features.
- No data-quality **business rules** — only the enforcement framework.
- No production deployments — staging + prod provisioned but unused in Phase 1.
- No probabilistic identity, MMM, holdouts, Python ML, multi-region (all Phase 2/3+).

---

## Linked prior runs

- (none — first requirement; Foundation sealed 2026-06-15)

## Notes

- Output-format request from the Stakeholder: for every section provide Design Decisions, Folder Structure, Configuration, Terraform Layout, Implementation Steps, Validation Steps, Risks, Recommendations — from the perspective of Principal Platform/DevOps/Data/Cloud Architects + Staff Engineer. Optimize for production readiness, simplicity, maintainability, scalability, low operational burden — not theoretical perfection.
- Canon anchors: STACK.md (seam bindings + 13 ADRs), HLD.md, TRIGGER-SURFACES.md, INVARIANTS.md, PLAYBOOK-deploy.md; execution basis docs 05 §14, 10 §5, 12 (Sprint-0 + operating model).
