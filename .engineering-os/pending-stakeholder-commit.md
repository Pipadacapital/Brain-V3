# Pending Stakeholder Commit — feat-metric-engine-parity

**Final review:** PASS / APPROVE (Stage 6, 2026-06-17). Awaiting Stakeholder gate (Stage 7).
**Branch:** `feat/metric-engine-parity` (base `master`). Commits already on branch: `d31fc84`, `a6d4870`, `5ec1c50`, `e9019b2` (build) + `08dcc2f`, `7d92fb8`, `7a55c10` (SEC-001 bounce fixes).

The work is already committed per-slice on the feature branch. The Stakeholder action is the **conscious accept + merge**, not a fresh `git add`. If a squash/verification re-stage is wanted, the explicit product-code paths (no `git add -A`) are:

```bash
git add \
  packages/metric-engine/src/registry.ts \
  packages/metric-engine/src/registry.test.ts \
  packages/metric-engine/src/deps.ts \
  packages/metric-engine/src/realized-revenue.ts \
  packages/metric-engine/src/provisional-revenue.ts \
  packages/metric-engine/src/index.ts \
  packages/metric-engine/package.json \
  packages/metric-engine/tsconfig.json \
  db/migrations/0020_provisional_gmv_as_of.sql \
  tools/parity-oracle/src/index.ts \
  tools/parity-oracle/src/reference.ts \
  tools/parity-oracle/src/parity.test.ts \
  tools/parity-oracle/package.json \
  tools/parity-oracle/turbo.json \
  eslint.config.mjs \
  turbo.json \
  .github/workflows/pr.yml
```

**Residual the Stakeholder consciously accepts:**
- **F-SEC-02 (MED, carried):** old `GetRealizedGmvAsOf` autocommit-GUC reset gap — NOT regressed by this slice (new engine uses `withBrandTxn`); must-fix-before-Phase-2 on the old query path.
- **SEC-003 / QA-F1 / QA-F2 (LOW):** report-omission + local-dev idempotency + ISO-2 (already strengthened) — deferred M2.

**Exit criterion delivered:** the M1 "parity oracle green" gate is non-tautological, RED-proven, CI-blocking, runs live-DB. Re-verified by the final reviewer.
</content>
