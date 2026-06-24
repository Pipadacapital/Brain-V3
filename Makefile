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
.PHONY: checkout-catalog checkout-run checkout-build checkout-verify
.PHONY: gold-run insights-pipeline attribution-gold-refresh recognition-refresh

silver-catalog:
	@echo ">> Applying Postgres read-shim view silver_order_ledger_src (uuid->text for JDBC)..."
	$(PG_PSQL) < db/starrocks/oltp_pg_read_shim.sql
	@echo ">> Creating StarRocks JDBC external catalog brain_oltp_pg (idempotent)..."
	$(SR_MYSQL) < db/starrocks/oltp_jdbc_catalog.sql
	@echo ">> Catalogs:"
	@$(SR_MYSQL) -e "SHOW CATALOGS;"

silver-run:
	@echo ">> dbt run (staging -> intermediate -> mart) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select stg_order_events_bronze+
	@echo ">> dbt test (grain, money-bigint, fold-consistency, schema tests) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" test --select silver_order_state silver_order_recognition int_order_lifecycle

silver-build: silver-catalog silver-run

# ============================================================================
# recognition-refresh — MEDALLION REALIGNMENT (Epic 1/2, decision B). Rebuild the revenue
# RECOGNITION ledger from Bronze: stg_order_events_bronze (Bronze order.live.v1) →
# silver_order_recognition (the 6 recognition event types) → gold_revenue_ledger. This is the
# Bronze-sourced REPLACEMENT for the PG realized_revenue_ledger write path (LedgerWriter +
# revenue-finalization). Scheduled hourly (cronworkflows: recognition-refresh) so the gold ledger
# stays fresh as new orders land in Bronze — the precondition for retiring the PG write path.
# `+gold_revenue_ledger` builds the model and every Bronze/oltp-shim parent.
recognition-refresh: silver-catalog
	@echo ">> dbt run — revenue recognition ledger (Bronze -> silver_order_recognition -> gold_revenue_ledger) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select +gold_revenue_ledger --threads 1
	@echo ">> Recognition ledger refreshed. Billing + attribution + dashboards now serve the Bronze-sourced gold ledger."

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
# feat-payments-checkout-silver — silver_checkout_signal dbt run wiring (mirror of the *-run targets).
# The payments/checkout-SIGNAL mart is the canonical Silver home for GoKwik RTO-Predict +
# Shopflo abandoned-checkout (and partner-gated GoKwik checkout/OTP later). It reads the RAW Iceberg
# Bronze (bronze_iceberg.collector_events), like silver_shipment — so the catalog target ensures the
# external Iceberg catalog exists (no Postgres read-shim). Same cron, no new deployable.
#
# Targets:
#   checkout-catalog  — ensure the StarRocks external Iceberg Bronze catalog exists (idempotent)
#   checkout-run      — dbt run (stg_checkout_signal_events -> silver_checkout_signal) + dbt test
#   checkout-build    — checkout-catalog then checkout-run
#   checkout-verify   — run dbt TWICE and diff a content checksum -> replay-idempotency proof
# ============================================================================
checkout-catalog:
	@echo ">> Ensuring StarRocks external Iceberg Bronze catalog exists (idempotent)..."
	$(SR_MYSQL) < db/starrocks/external_iceberg_catalog.sql

checkout-run:
	@echo ">> dbt run (stg_checkout_signal_events -> silver_checkout_signal) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select stg_checkout_signal_events+
	@echo ">> dbt test (grain, accepted-values, schema tests) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" test --select silver_checkout_signal stg_checkout_signal_events

checkout-build: checkout-catalog checkout-run

# Replay/idempotency proof: order-independent content fingerprint over ALL stable columns EXCEPT
# the build-time updated_at, rebuild, snapshot again, assert identical -> reproducible-from-source.
CHECKOUT_FP_SQL = SELECT SUM(CAST(murmur_hash3_32(CONCAT_WS('|', brand_id, event_id, signal_type, source, COALESCE(order_id,''), COALESCE(risk_flag,''), CAST(COALESCE(total_price_minor,0) AS STRING), CAST(COALESCE(total_discount_minor,0) AS STRING), CAST(has_address AS STRING), COALESCE(currency_code,''), CAST(occurred_at AS STRING), CAST(is_synthetic AS STRING))) AS BIGINT)) AS fp, COUNT(*) AS n FROM $(STARROCKS_DB).silver_checkout_signal;

checkout-verify: checkout-run
	@echo ">> [replay] content fingerprint after run #1 ..."
	@$(SR_MYSQL) -N -e "$(CHECKOUT_FP_SQL)" > /tmp/checkout_fp_1.txt
	@cat /tmp/checkout_fp_1.txt
	@echo ">> [replay] re-running dbt ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select stg_checkout_signal_events+
	@echo ">> [replay] content fingerprint after run #2 ..."
	@$(SR_MYSQL) -N -e "$(CHECKOUT_FP_SQL)" > /tmp/checkout_fp_2.txt
	@cat /tmp/checkout_fp_2.txt
	@if diff -q /tmp/checkout_fp_1.txt /tmp/checkout_fp_2.txt >/dev/null; then \
		echo ">> REPLAY PASS: silver_checkout_signal content is identical across re-runs (idempotent)."; \
	else \
		echo ">> REPLAY FAIL: silver_checkout_signal content changed between runs."; exit 1; \
	fi

# ============================================================================
# Phase 5 — Attribution credit ledger.
# MEDALLION REALIGNMENT (Epic 2 / decision B): the credit ledger is no longer a Postgres SoR.
# attribution_credit_ledger (migration 0032) was DROPPED (migration 0099); the ledger is now the
# app-written StarRocks table brain_gold.gold_attribution_credit (attribution-writer), and
# gold_marketing_attribution is a dbt VIEW over it. The reconcile driver (reconcile-attribution.ts)
# rebuilds it from silver_touchpoint + the gold revenue ledger — no PG table, no synthetic PG seed.
# The closed-sum parity oracle (packages/metric-engine attribution-parity-oracle.test.ts) is a pure
# in-memory CI gate; the live legs write/read gold directly. No make target seeds attribution anymore.
# ============================================================================

# ============================================================================
# re-platform Phase E — Gold serving marts (brain_gold). Reads Silver only; ADR-004-safe
# (additive aggregates only — non-additive ratios stay in the metric-engine). Gold models declare
# config(schema='brain_gold') and land there via the generate_schema_name macro. Requires the Silver
# marts to be built first (silver-run/journey-run/orderline-run/checkout-run).
#
#   gold-run — dbt run + test for every brain_gold model (tag:gold)
# ============================================================================
gold-run:
	@echo ">> dbt run (brain_gold serving marts — tag:gold) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select tag:gold
	@echo ">> dbt test (gold schema/grain tests) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" test --select tag:gold

# ============================================================================
# insights-pipeline — the buildable lakehouse path that powers the AI Copilot /insights surface.
# ONE command for a fresh env: wire the brain_oltp_pg JDBC catalog + ledger read-shim (silver-catalog),
# then build the Gold marts the Insight Engine reads (revenue / executive / customer / cac lineage)
# from REAL Postgres data via dbt. ledger_source defaults to `pg` (dbt_project.yml).
#
# Builds ALL marts: order/revenue/customer/cac from Postgres (JDBC) + touchpoint/journey/session from
# raw Iceberg Bronze (stg_touchpoint_events reads bronze_iceberg.collector_events; the bronze_events PG
# shim is retired). Single-threaded: the macOS dbt multiprocessing spawn crashes on >1 thread on a dev box.
#   make insights-pipeline
# ============================================================================
insights-pipeline: silver-catalog
	@echo ">> dbt run — all marts from real data (Postgres ledger via JDBC + touchpoint/journey via Iceberg Bronze) ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --full-refresh --threads 1
	@echo ">> Marts built. Open /insights (logged into a brand with order + pixel data)."

# ============================================================================
# attribution-gold-refresh — rebuild ONLY the attribution serving marts from the (reconcile-written)
# Postgres credit ledger, so the dashboard's Attribution surface (channel-ROAS / paths) serves the
# CURRENT attribution — including the data-driven (Markov) model — without a full insights-pipeline.
#
# Run AFTER the attribution-reconcile job writes the ledger:
#   node apps/.../jobs/attribution-reconcile.js   (writes all 5 models incl. data_driven to PG)
#   make attribution-gold-refresh                 (PG ledger → brain_gold.gold_marketing_attribution
#                                                   + gold_attribution_paths via dbt; ledger_source=pg)
# Single-threaded (macOS dbt spawn). gold_marketing_attribution is a passthrough of model_id, so every
# model the ledger holds (incl. data_driven) flows through with no mart change.
# ============================================================================
attribution-gold-refresh: silver-catalog
	@echo ">> dbt run — attribution serving marts (gold_marketing_attribution + gold_attribution_paths) from PG ledger ..."
	cd $(DBT_DIR) && DBT_PROFILES_DIR=$(DBT_PROFILES) "$(DBT)" run --select gold_marketing_attribution gold_attribution_paths --threads 1
	@echo ">> Attribution gold marts refreshed. The dashboard Attribution surface now serves data_driven."
