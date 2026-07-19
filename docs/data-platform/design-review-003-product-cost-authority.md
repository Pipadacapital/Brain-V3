# Design Review 003 — Product-Cost Authority

**Status:** APPROVED 2026-07-19 (owner: "go all" — Stages A+B+C) — EXECUTED on this branch; prod pre-gate + 0144 view-drop remain (§8/§10)
**Author:** Data Platform Architect session, 2026-07-19
**Scope:** one authoritative per-SKU COGS source; fixes a live correctness bug found during verification
**Companion:** `docs/data-inventory-2026-07-19.md` · DR-001 (#278) · DR-002 (#279)

---

## 1. Problem — this is a bug, not just duplication

Three stores carry (or claim to carry) per-SKU product cost, and the two that matter are **not connected**:

| Store | Created by | Written by | Read by |
|---|---|---|---|
| `public.gold_product_costs` (PG) | 0126, spec C.2.4 | `product-costs.ts` — the brand-facing **CSV cost-sheet upload** (bi-temporal, no-overlap exclusion constraint, idempotent versioning) | Only its own list endpoint (`analytics-logistics.routes`). **No compute path reads it.** |
| `billing.cost_input` (PG) | 0055 (the "rate-config ancestor") | `cost-inputs.ts` — `POST /api/v1/costs` (generic scope × cost_type, amount or pct_bps) | `gold_product_costs.py` (sku/cogs slice), `gold_contribution_margin.py`, CM2 recommendation detector |
| `brain_gold.gold_product_costs` (Iceberg) | transform | `gold_product_costs.py` — **derives from `billing.cost_input` only** | `gold_order_economics` (CM1 COGS), `gold_measurement_costs`, metric-lineage `product_costs` fact |

**Consequence:** a brand that uploads its COGS CSV — the purpose-built C.2.4 flow, whose own header says it "feeds gold_measurement_costs / gold_order_economics" — puts rows where the economics chain never looks. CM1's COGS stays 0 after a successful upload. The mart job was ported 1:1 from the Spark job written *before* the 0126 sheet existed and was never repointed. (Verified on `release` post-#279: the mart's source SQL is `FROM pg.billing.cost_input WHERE scope='sku' AND cost_type='cogs'`; no code syncs the sheet into `cost_input`.)

Secondary problems: the PG table is named like a Gold mart and lives in `public` — that naming actively caused this confusion — and there are **two doors** for the same fact (`CSV sheet` and `POST /costs scope=sku`), which is how divergence happens.

## 2. Analysis

- **Which table should own per-SKU unit COGS?** The sheet. It is purpose-built: bi-temporal validity with a DB-level no-overlap exclusion constraint per (sku, currency), integer-minor money with currency validation, idempotent version keys, CSV operator workflow. `cost_input` is a generic rate-config seam (pct_bps variable costs, global/category scopes) with none of those guarantees — right for rates, wrong for a unit-cost catalogue.
- **Migration risk is minimal *today*:** the mart's own docstring records that live `billing.cost_input` has **0 sku/cogs rows**, and the sheet is 0 rows in dev. There is no populated data to reconcile — the cheapest moment to fix authority is now (validated against prod counts in the runbook before cutover).
- **Engine placement is already correct** per the charter: operator-entered config belongs in PG; the Iceberg mart is a legitimate derived projection for DuckDB joins; serving exposure via the (DR-001-deleted) view is not needed. Nothing moves engines.
- PG 16 everywhere (local + Aurora) → `security_invoker` views available for the zero-downtime rename. `product-costs.ts` deliberately avoids `ON CONFLICT` (its own comment, line 196) → a plain auto-updatable compatibility view covers its INSERT/UPDATE/SELECT exactly.

## 3. Trade-offs

| Option | Gain | Cost |
|---|---|---|
| **A (recommended): sheet is SoT; repoint mart to the sheet; close the sku/cogs door on `cost_input`; move+rename the table** | Upload path actually feeds economics (bug fixed); one door per fact; `public` schema cleaned; name stops lying | App SQL refs updated (one module + one route); one migration + one-release compat view |
| B: `cost_input` is SoT; make CSV ingest write `cost_input`; drop the sheet | Fewer tables (−1) | Throws away the purpose-built constraints (no-overlap enforcement moves to app-only), bends a rate table into a unit catalogue, larger app rewrite — merging for aesthetics, against the DR-002 lesson |
| C: dual-write / sync job | No reader changes | A sync job is a new moving part that exists to keep two copies of one fact — the exact debt class this program deletes |
| D: fix nothing, document | Zero risk | The C.2.4 upload stays silently broken |

## 4. Risks

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Prod has non-zero sku/cogs rows in `cost_input` (docstring stale) | Low | Cutover would drop configured COGS from the mart | Runbook gate: count first; if >0, one-time INSERT-SELECT copy into the sheet inside 0143 (idempotent version keys make this safe) |
| Old app pods write the old table name during rollout | Certain (brief window) | Upload 500s without compat | `public.gold_product_costs` becomes a `security_invoker` auto-updatable VIEW over the renamed table for exactly one release; dropped in 0144 |
| RLS behavior through the view | — | Tenant leak would be critical | `security_invoker = true` → RLS evaluates as `brain_app`, identical to today; validation SQL proves cross-brand reads return 0 |
| Mart repoint changes COGS values | — | CM1 wrong | Both sources empty ⇒ output identical (empty) today; mapping is column-for-column (sheet already carries source_event_id, valid_from/valid_to) |
| Sheet exclusion constraint travels with rename | — | Overlap protection lost | `ALTER TABLE … SET SCHEMA` moves constraints/indexes/policies intact (metadata-only); validation SQL asserts constraint present post-move |

## 5. Alternatives considered
Options B–D above, rejected. Also considered: leaving the table in `public` under its current name (rejected — the name is what caused the miswiring; `public` should hold only `pgmigrations`; `dev_secret`/`_rls_demo` stay put as dev/test-only fixtures, explicitly deferred).

## 6. Recommended solution — Option A in three stages

**Stage A — fix the bug (mart repoint).** `gold_product_costs.py` source becomes the cost sheet: `SELECT brand_id, sku, cost_minor, currency_code, valid_from, valid_to, 'cost_sheet_csv' AS source_system, source_event_id FROM pg.billing.product_cost_sheet` (post-rename name; same graceful PG-unreachable degradation). `cost_input` remains the source for *rate* configs consumed by contribution-margin — unchanged.

**Stage B — rename/move (migration 0143 + app refs).** `public.gold_product_costs` → `billing.product_cost_sheet`; compatibility view for one release; `product-costs.ts` + `analytics-logistics.routes.ts` SQL updated to the new name in the same PR. 0144 (next wave) drops the view.

**Stage C — one door.** `cost-inputs.ts` rejects `scope='sku' && cost_type='cogs'` with a message pointing at the sheet upload; contract description updated. Rates (pct_bps, global/category) unaffected.

## 7. SQL / implementation

### Migration `0143_product_cost_sheet_authority.sql`

```sql
-- DR-003: per-SKU COGS authority = the cost sheet. Rename out of public, keep a one-release
-- compatibility view (security_invoker → RLS evaluates as the querying role, same as today).
-- If prod billing.cost_input holds sku/cogs rows (expected 0 — runbook-gated), copy them first:
--   INSERT INTO billing.product_cost_sheet (...) SELECT ... FROM billing.cost_input
--    WHERE scope='sku' AND cost_type='cogs' AND amount_minor IS NOT NULL ON CONFLICT DO NOTHING;
ALTER TABLE public.gold_product_costs SET SCHEMA billing;
ALTER TABLE billing.gold_product_costs RENAME TO product_cost_sheet;
CREATE VIEW public.gold_product_costs WITH (security_invoker = true)
  AS SELECT * FROM billing.product_cost_sheet;
```

### Rollback SQL (header comment)
```sql
DROP VIEW IF EXISTS public.gold_product_costs;
ALTER TABLE billing.product_cost_sheet RENAME TO gold_product_costs;
ALTER TABLE billing.gold_product_costs SET SCHEMA public;
```

### Validation SQL
```sql
SELECT to_regclass('billing.product_cost_sheet') IS NOT NULL;                      -- true
SELECT relkind FROM pg_class WHERE oid = 'public.gold_product_costs'::regclass;   -- 'v'
SELECT count(*) FROM pg_constraint WHERE conrelid='billing.product_cost_sheet'::regclass
   AND contype='x';                                                               -- 1 (no-overlap kept)
SELECT count(*) FROM pg_policies WHERE schemaname='billing'
   AND tablename='product_cost_sheet';                                            -- ≥1 (RLS moved)
-- prod pre-gate: SELECT count(*) FROM billing.cost_input WHERE scope='sku' AND cost_type='cogs';
```

## 8. Validation steps
1. Migration up → validation SQL → rollback → up (idempotency + reversibility on dev).
2. Upload a test CSV via the endpoint → rows in `billing.product_cost_sheet` → run gold tier → **`brain_gold.gold_product_costs` is populated → `gold_order_economics` COGS ≠ 0** — the end-to-end proof the bug is dead (this exact flow fails today).
3. `cost-inputs` rejection test (sku+cogs → 400 with pointer; rate configs still accepted).
4. Core typecheck + product-costs/cost-inputs unit+live tests; RLS cross-brand read through the compat view returns 0 rows.
5. Refresh green; metric-lineage `product_costs` fact (Iceberg mart) now counts real rows post-upload.

## 9. Rollback strategy
Stage-scoped git reverts + the rollback SQL above (pure metadata renames — instant, no data movement at any step). The mart repoint reverts independently of the rename (compat view keeps old name resolving either way during transition).

## 10. Monitoring requirements
- Post-promotion: `gold_order_economics` rows with `cogs_minor > 0` after the first real sheet upload (the bug's tombstone metric).
- One release later: confirm zero traffic hits the compat view (pg_stat views or log sampling), then 0144 drops it.
- Existing refresh/tick monitoring unchanged.

## 11. Future scalability
One fact, one door, one derivation: CSV sheet (operator truth, PG) → Iceberg mart (analytical projection) → economics chain. Adding cost sources later (connector catalog costs, 3PL invoices) means new *inputs to the sheet's ingest*, never new sibling tables. The `cost_input` seam stays what it was born to be — rate configs — and the last analytically-named table leaves `public`.
