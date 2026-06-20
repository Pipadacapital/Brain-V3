# ============================================================================
# Brain — Silver-tier dbt run wiring (feat-silver-tier-order-state).
# Replay-safe, idempotent. No new deployable (I-E05) — this is a dev/CI invocation;
# a prod schedule reuses an existing Argo cron (documented intent, not this slice).
#
# Prereqs (dev):
#   * StarRocks up (brainv3-starrocks-1 :9030) + Postgres up (brainv3-postgres-1).
#   * The brain_oltp_pg JDBC catalog created (`make silver-catalog`).
#   * dbt-starrocks available. If not on PATH, point DBT at a venv:
#       make silver-run DBT=.dbt-venv/bin/dbt
#
# Targets:
#   silver-catalog  — create the StarRocks JDBC external catalog over Postgres (idempotent)
#   silver-run      — dbt run (staging→intermediate→mart) + dbt test
#   silver-build    — silver-catalog then silver-run (full from-scratch reproduce)
#   silver-verify   — run dbt TWICE and diff a content checksum → proves replay-idempotency
# ============================================================================

# StarRocks connection (dev defaults; override via env)
STARROCKS_CONTAINER ?= brainv3-starrocks-1
STARROCKS_HOST      ?= 127.0.0.1
STARROCKS_PORT      ?= 9030
STARROCKS_USER      ?= root
STARROCKS_DB        ?= brain_silver

# dbt invocation. If a local venv exists (.dbt-venv), use it; else fall back to PATH `dbt`.
# Override explicitly with `make silver-run DBT=/abs/path/to/dbt`.
REPO_ROOT    := $(abspath $(dir $(lastword $(MAKEFILE_LIST))))
DBT          ?= $(if $(wildcard $(REPO_ROOT)/.dbt-venv/bin/dbt),$(REPO_ROOT)/.dbt-venv/bin/dbt,dbt)
DBT_DIR      := db/dbt
DBT_PROFILES := profiles

# Postgres (for the JDBC read-shim view).
PG_CONTAINER ?= brainv3-postgres-1
PG_USER      ?= brain
PG_DB        ?= brain

# mysql client: prefer host mysql; else exec into the StarRocks container.
SR_MYSQL ?= docker exec -i $(STARROCKS_CONTAINER) mysql -h127.0.0.1 -P$(STARROCKS_PORT) -u$(STARROCKS_USER)
PG_PSQL  ?= docker exec -i $(PG_CONTAINER) psql -U $(PG_USER) -d $(PG_DB)

.PHONY: silver-catalog silver-run silver-build silver-verify
.PHONY: journey-catalog journey-run journey-build journey-verify journey-seed
.PHONY: orderline-catalog orderline-ddl orderline-run orderline-build orderline-verify
.PHONY: attribution-migrate attribution-seed attribution-build attribution-verify

silver-catalog:
	@echo ">> Applying Postgres read-shim view silver_order_ledger_src (uuid->text for JDBC)..."
	$(PG_PSQL) < db/starrocks/oltp_pg_read_shim.sql
	@echo ">> Creating StarRocks JDBC external catalog brain_oltp_pg (idempotent)..."
	$(SR_MYSQL) < db/starrocks/oltp_jdbc_catalog.sql
	@echo ">> Catalogs:"
	@$(SR_MYSQL) -e "SHOW CATALOGS;"

silver-run:
	@echo ">> dbt run (staging -> intermediate -> mart) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select stg_order_ledger_events+
	@echo ">> dbt test (grain, money-bigint, fold-consistency, schema tests) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" test --select silver_order_state stg_order_ledger_events int_order_lifecycle

silver-build: silver-catalog silver-run

# Replay/idempotency proof: snapshot an order-independent content fingerprint (sum of
# per-row hashes over ALL columns EXCEPT the build-time updated_at), rebuild, snapshot
# again, and assert the two fingerprints match → proves the mart is reproducible-from-source.
SILVER_FP_SQL = SELECT SUM(CAST(murmur_hash3_32(CONCAT_WS('|', brand_id, order_id, lifecycle_state, CAST(is_terminal AS STRING), CAST(order_value_minor AS STRING), currency_code, CAST(first_event_at AS STRING), CAST(state_effective_at AS STRING))) AS BIGINT)) AS fp, COUNT(*) AS n FROM $(STARROCKS_DB).silver_order_state;

silver-verify: silver-run
	@echo ">> [replay] content fingerprint after run #1 ..."
	@$(SR_MYSQL) -N -e "$(SILVER_FP_SQL)" > /tmp/silver_fp_1.txt
	@cat /tmp/silver_fp_1.txt
	@echo ">> [replay] re-running dbt ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select stg_order_ledger_events+
	@echo ">> [replay] content fingerprint after run #2 ..."
	@$(SR_MYSQL) -N -e "$(SILVER_FP_SQL)" > /tmp/silver_fp_2.txt
	@cat /tmp/silver_fp_2.txt
	@if diff -q /tmp/silver_fp_1.txt /tmp/silver_fp_2.txt >/dev/null; then \
		echo ">> REPLAY PASS: silver_order_state content is identical across re-runs (idempotent)."; \
	else \
		echo ">> REPLAY FAIL: silver_order_state content changed between runs."; exit 1; \
	fi

# ============================================================================
# feat-journey-touchpoint — silver.touchpoint dbt run wiring (mirror of silver-*).
# Replay-safe, idempotent. The journey mart is the SECOND Silver mart; same pattern,
# same cron, no new deployable (I-E05).
#
# Targets:
#   journey-catalog  — apply the Postgres read-shim views (bronze_touchpoint_src +
#                      connector_journey_stitch_map_src) for the JDBC catalog (idempotent)
#   journey-seed     — load the CLEARLY-LABELLED synthetic journey fixtures into bronze_events
#                      + connector_journey_stitch_map (loaded ONLY after the real build is
#                      proven; every row carries payload.properties._synthetic=true)
#   journey-run      — dbt run (staging→intermediate→mart) + dbt test for the journey mart
#   journey-build    — journey-catalog then journey-run (full from-scratch reproduce)
#   journey-verify   — run dbt TWICE and diff a content checksum → replay-idempotency proof
# ============================================================================

journey-catalog:
	@echo ">> Applying Postgres read-shim views bronze_touchpoint_src + connector_journey_stitch_map_src (uuid->text for JDBC)..."
	$(PG_PSQL) < db/starrocks/bronze_touchpoint_src.sql
	@echo ">> Ensuring StarRocks JDBC external catalog brain_oltp_pg exists (idempotent)..."
	$(SR_MYSQL) < db/starrocks/oltp_jdbc_catalog.sql

journey-seed:
	@echo ">> Loading CLEARLY-LABELLED synthetic journey fixtures (_synthetic=true) into Postgres bronze..."
	$(PG_PSQL) < db/dbt/seeds/journey_synthetic_fixtures.sql

journey-run:
	@echo ">> dbt run (stg_touchpoint_events -> int_touchpoint_sessionized -> silver_touchpoint) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select stg_touchpoint_events+
	@echo ">> dbt test (grain, no-money, replay-fold, schema tests) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" test --select silver_touchpoint stg_touchpoint_events int_touchpoint_sessionized

journey-build: journey-catalog journey-run

# Replay/idempotency proof: order-independent content fingerprint (sum of per-row hashes
# over ALL stable columns EXCEPT the build-time updated_at), rebuild, snapshot again,
# assert identical → proves the mart is reproducible-from-source.
JOURNEY_FP_SQL = SELECT SUM(CAST(murmur_hash3_32(CONCAT_WS('|', brand_id, brain_anon_id, CAST(touch_seq AS STRING), session_key, CAST(session_seq AS STRING), CAST(is_first_touch AS STRING), CAST(is_last_touch AS STRING), CAST(occurred_at AS STRING), event_type, channel, COALESCE(utm_source,''), COALESCE(utm_medium,''), COALESCE(utm_campaign,''), COALESCE(fbclid,''), COALESCE(gclid,''), COALESCE(ttclid,''), COALESCE(referrer_host,''), COALESCE(landing_path,''), COALESCE(stitched_order_id,''), COALESCE(stitched_brain_id,''), CAST(is_synthetic AS STRING))) AS BIGINT)) AS fp, COUNT(*) AS n FROM $(STARROCKS_DB).silver_touchpoint;

journey-verify: journey-run
	@echo ">> [replay] content fingerprint after run #1 ..."
	@$(SR_MYSQL) -N -e "$(JOURNEY_FP_SQL)" > /tmp/journey_fp_1.txt
	@cat /tmp/journey_fp_1.txt
	@echo ">> [replay] re-running dbt ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select stg_touchpoint_events+
	@echo ">> [replay] content fingerprint after run #2 ..."
	@$(SR_MYSQL) -N -e "$(JOURNEY_FP_SQL)" > /tmp/journey_fp_2.txt
	@cat /tmp/journey_fp_2.txt
	@if diff -q /tmp/journey_fp_1.txt /tmp/journey_fp_2.txt >/dev/null; then \
		echo ">> REPLAY PASS: silver_touchpoint content is identical across re-runs (idempotent)."; \
	else \
		echo ">> REPLAY FAIL: silver_touchpoint content changed between runs."; exit 1; \
	fi

# ============================================================================
# feat-shopify-order-depth — silver.order_line dbt run wiring (mirror of silver-*/journey-*).
# The order line-item mart is the THIRD Silver mart; same pattern, same cron, no new
# deployable. Reads the order depth the mapper captures into Bronze.
#
# Targets:
#   orderline-catalog  — apply the Postgres read-shim view bronze_order_line_src (latest-order
#                        pick + line_items unnest, uuid/jsonb→text) for the JDBC catalog
#   orderline-ddl      — create the StarRocks brain_silver.silver_order_line table (idempotent)
#   orderline-run      — dbt run (stg_order_line_events → silver_order_line) + dbt test
#   orderline-build    — orderline-catalog then orderline-ddl then orderline-run
#   orderline-verify   — run dbt TWICE and diff a content checksum → replay-idempotency proof
# ============================================================================
orderline-catalog:
	@echo ">> Applying Postgres read-shim view bronze_order_line_src (latest-order + line_items unnest, uuid/jsonb->text)..."
	$(PG_PSQL) < db/starrocks/bronze_order_line_src.sql
	@echo ">> Ensuring StarRocks JDBC external catalog brain_oltp_pg exists (idempotent)..."
	$(SR_MYSQL) < db/starrocks/oltp_jdbc_catalog.sql

orderline-ddl:
	@echo ">> Creating StarRocks brain_silver.silver_order_line (idempotent)..."
	$(SR_MYSQL) < db/starrocks/ddl/silver_order_line.sql

orderline-run:
	@echo ">> dbt run (stg_order_line_events -> silver_order_line) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select stg_order_line_events+
	@echo ">> dbt test (grain, money-bigint, replay-identity, schema tests) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" test --select silver_order_line stg_order_line_events

orderline-build: orderline-catalog orderline-ddl orderline-run

# Replay/idempotency proof: order-independent content fingerprint over ALL stable columns,
# rebuild, snapshot again, assert identical → proves the mart is reproducible-from-source.
ORDERLINE_FP_SQL = SELECT SUM(CAST(murmur_hash3_32(CONCAT_WS('|', brand_id, order_id, CAST(line_index AS STRING), COALESCE(sku,''), COALESCE(title,''), CAST(quantity AS STRING), CAST(unit_price_minor AS STRING), CAST(line_total_minor AS STRING), CAST(line_discount_minor AS STRING), COALESCE(product_id,''), COALESCE(variant_id,''), COALESCE(currency_code,''), CAST(occurred_at AS STRING))) AS BIGINT)) AS fp, COUNT(*) AS n FROM $(STARROCKS_DB).silver_order_line;

orderline-verify: orderline-run
	@echo ">> [replay] content fingerprint after run #1 ..."
	@$(SR_MYSQL) -N -e "$(ORDERLINE_FP_SQL)" > /tmp/orderline_fp_1.txt
	@cat /tmp/orderline_fp_1.txt
	@echo ">> [replay] re-running dbt ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select stg_order_line_events+
	@echo ">> [replay] content fingerprint after run #2 ..."
	@$(SR_MYSQL) -N -e "$(ORDERLINE_FP_SQL)" > /tmp/orderline_fp_2.txt
	@cat /tmp/orderline_fp_2.txt
	@if diff -q /tmp/orderline_fp_1.txt /tmp/orderline_fp_2.txt >/dev/null; then \
		echo ">> REPLAY PASS: silver_order_line content is identical across re-runs (idempotent)."; \
	else \
		echo ">> REPLAY FAIL: silver_order_line content changed between runs."; exit 1; \
	fi

# ============================================================================
# Phase 5 — Attribution credit ledger (migration 0032 + synthetic fixtures).
# The credit ledger is a Postgres Gold SoR (RLS FORCE, append-only). It is
# rebuildable from silver.touchpoint + realized_revenue_ledger — the synthetic
# fixtures are CLEARLY-LABELLED dev enrichment (real journey data is thin).
# ============================================================================

attribution-migrate:
	@echo ">> Applying additive migration 0032_attribution_credit_ledger.sql (RLS FORCE, append-only, seams)..."
	$(PG_PSQL) -v ON_ERROR_STOP=1 < db/migrations/0032_attribution_credit_ledger.sql

attribution-seed: attribution-migrate
	@echo ">> Loading CLEARLY-LABELLED synthetic attribution fixtures (model_version=v1-synthetic-fixture) into the credit ledger..."
	$(PG_PSQL) -v ON_ERROR_STOP=1 < db/dbt/seeds/attribution_synthetic_fixtures.sql

attribution-build: attribution-seed

# Replay/idempotency proof: re-running the seed must add NO rows (append-only +
# ON CONFLICT DO NOTHING on the dedup key). Row count is stable across re-seeds.
attribution-verify: attribution-seed
	@echo ">> [replay] credit-ledger row count after seed #1 ..."
	@$(PG_PSQL) -tAc "SELECT COUNT(*) FROM attribution_credit_ledger WHERE model_version='v1-synthetic-fixture';" > /tmp/acl_count_1.txt
	@cat /tmp/acl_count_1.txt
	@echo ">> [replay] re-loading the synthetic seed (must be a no-op) ..."
	$(PG_PSQL) -v ON_ERROR_STOP=1 < db/dbt/seeds/attribution_synthetic_fixtures.sql > /dev/null
	@echo ">> [replay] credit-ledger row count after seed #2 ..."
	@$(PG_PSQL) -tAc "SELECT COUNT(*) FROM attribution_credit_ledger WHERE model_version='v1-synthetic-fixture';" > /tmp/acl_count_2.txt
	@cat /tmp/acl_count_2.txt
	@if diff -q /tmp/acl_count_1.txt /tmp/acl_count_2.txt >/dev/null; then \
		echo ">> REPLAY PASS: attribution_credit_ledger row count is identical across re-seeds (append-only / idempotent)."; \
	else \
		echo ">> REPLAY FAIL: attribution_credit_ledger row count changed between re-seeds."; exit 1; \
	fi
