# Brain — monorepo

AI-native commerce OS for DTC brands (India / UAE / GCC). Single TypeScript monorepo;
**modular monolith first** — 3 deployables + the web app, with future service extraction
when a trigger fires. Canonical specs live in the **Brain-docs** repo (01 BRD → 05 Build Plan);
the structure here matches **doc 05 §2–§3**.

## Layout
- `apps/` — `collector` · `stream-worker` · `core` (13 modules) · `web`
- `packages/` — shared libs: contracts (Zod = source of truth), metric-engine, money,
  feature-flags, tenant-context, identity-core, audit, db, events, observability,
  ai-gateway-client, config, ui
- `db/` — migrations · starrocks · iceberg · dbt   ·   `infra/` — terraform · helm · argocd
- `tools/` — parity-oracle · eval · isolation-fuzz · seed   ·   `docs/` — adr · runbooks · playbooks · architecture

## The two rules that keep it a *modular* monolith
1. `apps/` may import `packages/`, never another `apps/`; `packages/` never import `apps/`.
2. Inside `core/`, modules talk only through each other's `index.ts` (or an event) —
   reaching into another module's `internal/` fails the ESLint boundary rule.

## Getting started
```bash
pnpm install
cp .env.example .env.local
pnpm dev          # control-plane + serving profile + core + web
pnpm dev:ingest   # the strict-SLA event path (collector + stream-worker)
pnpm test:isolation && pnpm test:parity   # the non-negotiable Phase-1a gates
```
Tooling: Turborepo + pnpm + TypeScript (build-tooling choices — doc 05 §16; swappable).
