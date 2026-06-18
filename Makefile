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
