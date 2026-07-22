"""
run_all.py — Phase 1d: the SINGLE-PROCESS transform runner.

WHY: prod telemetry (2026-07-16) showed every DuckDB job costs ~85s of FIXED per-process overhead
(Python + DuckDB startup + Iceberg REST-catalog ATTACH + S3/IRSA setup) — the keystone that scans ALL of
Bronze and the leaf that reads a tiny slice and upserts ZERO both take ~85-92s. The old runner spawns 90
processes per run (45 jobs × 2 passes), so a `*/5` run takes ~130 min — the scan/rows were never the
bottleneck, the process count was. This runner attaches the catalog ONCE and runs every job's existing
`__main__` (its `run_job` call) against ONE shared connection, collapsing ~90 attaches
into one. Expected: ~130 min → ~single-digit minutes, so the `*/5` schedule finally delivers realtime.

HOW: we do NOT rewrite the 90 jobs. We reuse each job file verbatim by executing its `__main__` via runpy,
after patching `_base.connect` to hand every `run_job` the SAME connection
(close-proofed so a job's `con.close()` is a no-op). The per-job discipline (pin `_CURRENT_HI`, window,
MERGE, advance watermark) is unchanged — only the connection is shared.

Connection-state hygiene (the one thing a shared connection changes): jobs register scalar UDFs with
`con.create_function(...)`, which raises "already exists" the SECOND time (pass 2, or a name shared across
jobs). We wrap `create_function` to be idempotent (first registration wins). Temp views already use
`CREATE OR REPLACE`, so they are safe.

RUNNER: this is the SOLE transform runner (ADR-0016 P2 retired the old 90-spawn bash loop + its
`sparkV4.singleProcess` dual-path flag — the v4-medallion CronWorkflow and tools/dev/duckdb-refresh.sh
both call this). Usage:
    python run_all.py silver     # keystone+spine required, then 2 passes over the rest
    python run_all.py gold        # revenue_ledger required, attribution chain, then the rest (1 pass)
Exit 1 if any non-required job failed (best-effort); a required job aborts hard.

──────────────────────────────────────────────────────────────────────────────────────────────────
ADR-0016 P2.2 — RESIDENT WARM MICRO-BATCH WORKER (kills per-tick cold start).

The single-shot path above pays the ~85s attach ONCE per RUN, but a `*/5` CronWorkflow still spins a
fresh pod + boots DuckDB + re-attaches the catalog EVERY tick. `run_all.py resident` promotes this into
a long-lived Deployment: ONE warm DuckDB connection + attached catalog held ACROSS ticks, looping the
chained pipeline every TRANSFORM_TICK_MS over incremental deltas. Warm process = zero per-tick startup.

    python run_all.py resident    # loop: [leader-lock] silver → node identity(subprocess) → gold, forever

The chain CROSSES LANGUAGES: the Python silver + gold stages run on the WARM shared connection; between
them the NODE silver-identity job (+ silver_identity_map re-projection) runs as a SUBPROCESS — the same
`SILVER_IDENTITY_CMD` idiom tools/dev/duckdb-refresh.sh uses. The Python stages stay warm; only the node
step forks a process, exactly as designed (the identity resolver ships in the stream-worker deployable).

SINGLE-WRITER: two replicas must never both write. Each tick is gated on a Postgres advisory lock via
pg_try_advisory_lock (LEADER_LOCK_TRANSFORM_WORKER), mirroring apps/stream-worker/.../pg/LeaderLock.ts:
whichever replica wins the lock for a tick is that tick's leader; non-leaders skip cheaply and retry next
tick — no leader-election handshake, no leader-death recovery. The lock is a SESSION lock held on ONE
dedicated PG connection only for the tick body and released in a finally (no idle-in-transaction).

SIGNALS: SIGTERM/SIGINT drain the IN-FLIGHT tick (never interrupt a mid-tick MERGE), then close the warm
connection and exit 0 — k8s-graceful. A tiny stdlib /healthz HTTP endpoint (a thread) returns 200 while
the loop is alive so the Deployment's liveness probe can restart a wedged worker.

FLAG: the resident mode is opt-in — `resident` argv (chart `.Values.transformWorker.enabled` runs the
Deployment with this arg); the `silver`/`gold` single-shot paths are UNCHANGED so the CronWorkflow keeps
working until the resident worker is validated (ADR-0016 D3 cutover: enabling transformWorker suppresses
the v4-medallion cron, so the two never both write).

CORE-ONLY (TRANSFORM_CORE_ONLY, CORE↔IDENTITY re-split 2026-07-19): identity was decoupled onto its own
v4-identity cron. When this flag is set — on the resident loop AND on the single-shot `silver` tier the
v4-medallion cron runs — the CORE writer NEVER touches the identity-owned Silver marts (silver_identity_
map/_alias, silver_customer_identity, silver_identity_unmerge): run_tier('silver') excludes them and
run_one_tick skips the node identity subprocess + the map re-projection. The v4-identity cron is the SOLE
identity writer; gold reads the last-written silver_identity_map (bi-temporal Iceberg, converges). This
prevents two writers on one Iceberg table AND keeps the slow identity resolve off the core path. Default
false = pre-flag behaviour (fully reversible).
"""
from __future__ import annotations

import glob
import json
import os
import runpy
import signal
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "silver"))  # silver-side shared modules (_silver_technical etc.)

import _base  # noqa: E402
import _catalog  # noqa: E402

# ── Resident-worker config (env-tunable; all default to safe values) ────────────────────────────────
# Micro-batch cadence: run the chained pipeline once per this interval (ADR-0016 default 45s). A tick
# that runs LONGER than the interval simply starts the next one immediately (no overlap — single loop).
TRANSFORM_TICK_MS = int(os.environ.get("TRANSFORM_TICK_MS", "45000"))
# Liveness HTTP port for the k8s probe (stdlib http.server on a daemon thread).
TRANSFORM_WORKER_HEALTH_PORT = int(os.environ.get("TRANSFORM_WORKER_HEALTH_PORT", "8092"))
# Postgres advisory-lock key for the single-writer gate. MIRRORS the 910_00x namespace of
# apps/stream-worker/src/infrastructure/pg/LeaderLock.ts (910_001 ingest[retired]/910_002 sync-claimer/
# 910_003 dq-checks/910_004 silver-identity) — 910_005 is the transform worker's tick lock. Overridable
# for isolation in tests/multi-tenant clusters.
LEADER_LOCK_TRANSFORM_WORKER = int(os.environ.get("TRANSFORM_WORKER_LOCK_KEY", "910005"))
# The node silver-identity subprocess (+ its map re-projection follows on the warm conn). Same default
# idiom as tools/dev/duckdb-refresh.sh; a container overrides with a built dist path.
SILVER_IDENTITY_CMD = os.environ.get(
    "SILVER_IDENTITY_CMD", "pnpm --filter @brain/stream-worker run job:silver-identity"
)
# ── Wave 3 (2026-07-22): per-tick catalog refresh — the fix for the 2026-07-20 resident revert ───────
# WHY THE RESIDENT WAS SHELVED: it held ONE warm DuckDB+Iceberg attach for the process lifetime, so its
# cached snapshot metadata (file list, manifest URIs) went STALE as Kafka-Connect appended new Bronze
# snapshots and maintenance expired+physically-deleted the old data files — a later tick's scan then tried
# to open files that no longer existed → 400. The cold */5 cron never hit this (fresh attach per run).
# THE FIX, now affordable: rebuild the shared connection at the TOP of every tick (mirrors duckdb-serving's
# 60s epoch rotation). This was too expensive pre-Wave-1 (cold read of the 733-file keystone = ~289s); AFTER
# the repartition (keystone → 1-3 files) a cold attach+read is seconds, so a fresh connection per 45s tick
# is cheap AND can never carry stale file handles. The resident's remaining edge over the cron is the tight
# cadence (45s vs */5+run-time) and the held health/leader/UDF state — NOT connection reuse, which was the
# bug. Default ON (it is the correctness fix); RESIDENT_REFRESH_PER_TICK=0 restores the old warm-hold for
# an A/B or a low-churn cluster that never needed it.
RESIDENT_REFRESH_PER_TICK = os.environ.get("RESIDENT_REFRESH_PER_TICK", "1").strip().lower() in (
    "1", "true", "yes", "on",
)

# ── CORE-ONLY switch (CORE↔IDENTITY re-split, 2026-07-19) ───────────────────────────────────────────
# The identity lane (Neo4j resolve → identity-owned Silver marts) was DECOUPLED out of the blocking core
# chain onto its OWN cron (infra/helm/cronworkflows/templates/v4-identity.yaml). When TRANSFORM_CORE_ONLY
# is set, the CORE writer (the resident loop AND the single-shot `silver` tier the v4-medallion cron runs)
# must NOT touch the identity-owned tables — the v4-identity lane is their SOLE writer. Two writers on one
# Iceberg table is a write-conflict; a slow identity job in the core chain also re-blocks core freshness
# (the exact regression the decouple fixed). Default false = today's behaviour (fully reversible): core
# still runs identity in-process and writes the map, exactly as before this flag existed.
#
# IDENTITY_OWNED_JOBS — the silver_*.py jobs OWNED by the v4-identity lane (each reads Neo4j and/or writes
# an identity-owned Iceberg table: silver_identity_map/_alias, silver_customer_identity, silver_identity_
# unmerge). CONFIRMED by grep (2026-07-19): these are the only silver_*.py that import the neo4j driver
# and MERGE into the identity tables. silver_session_identity.py is NOT here — it WRITES the session mart
# and only READS silver_identity_map (read-only, core-owned). When TRANSFORM_CORE_ONLY is on, run_tier
# EXCLUDES this set from the silver glob and run_one_tick SKIPS the identity subprocess + the explicit
# silver_identity_map re-projection. Gold then reads the LAST-written silver_identity_map (persisted by
# the v4-identity lane — a bi-temporal Iceberg table; slightly stale, converges — safe).
TRANSFORM_CORE_ONLY = os.environ.get("TRANSFORM_CORE_ONLY", "").strip().lower() in ("1", "true", "yes", "on")
IDENTITY_OWNED_JOBS = frozenset({
    "silver_identity_map.py",
    "silver_identity_alias.py",
    "silver_customer_identity.py",
    "silver_identity_unmerge.py",
})

# ── Tiered gold cadence (P1 — medallion slowness remediation, ADR-0019 follow-up) ────────────────────
# GOLD_HEAVY_JOBS are the always-FULL-SCAN gold marts that dominate the pass (measured prod: revenue_ledger
# ~21min + journey_events_reversion ~13min = 63% of the gold pass) and CANNOT be made incremental —
# gold_revenue_ledger / gold_cac / gold_contribution_margin fold with delete_orphans / two independent
# Silver source clocks (money-safety; see gold_contribution_margin.py), and journey_events_reversion is a
# correctness-eventual BI job. They don't need */5 freshness, so we DECOUPLE them onto a slower cadence
# (the v4-medallion-heavy CronWorkflow) instead of dragging every 5-min tick. The fast lane reads their
# LAST-WRITTEN Iceberg table (slightly stale, converges — the same stale-tolerant pattern the CORE↔IDENTITY
# split already uses for silver_identity_map). GOLD_LANE selects which marts a `run_all.py gold` run owns:
#   "all"  (default) — today's behaviour: the single tick runs every gold mart (dev shim, resident, legacy).
#   "fast"           — skip GOLD_HEAVY_JOBS (the */5 fast lane).
#   "heavy"          — run ONLY GOLD_HEAVY_JOBS (the */20 heavy lane).
# Silver and every non-gold tier ignore GOLD_LANE entirely.
GOLD_HEAVY_JOBS = frozenset({
    "gold_revenue_ledger.py",
    "gold_journey_events_reversion.py",
    "gold_cac.py",
    "gold_contribution_margin.py",
})
GOLD_LANE = os.environ.get("GOLD_LANE", "all").strip().lower()

# ── Wave 2a: HOT-TABLE MAINTENANCE FOLDED INTO THE TRANSFORM TICK (2026-07-21 keystone incident) ──────
# The */5 medallion MERGE churn re-fragments silver_collector_event ~2.4 files/min (723→1,442 live files
# in ~5h); duckdb-iceberg's EXECUTE phase costs ~200ms PER DATA FILE on a cold serving connection, so an
# un-compacted keystone blows past ANY serving statement budget on file-count alone. The
# v4-maintenance-silver-hot cron lane exists to counter this, but it runs on its OWN */2h schedule —
# out of phase with the churn it chases. This hook compacts+expires the SAME hot tables at the END of the
# gold pass, INSIDE the transform run's own process/lock, so compaction rides the churn that produced it.
#
# It reuses the maintenance client (mb.optimize / mb.expire) verbatim — no duplicated compaction logic —
# and is HARD-ISOLATED: any failure is logged loudly and NEVER changes the transform run's exit code or
# `fails` tally (the medallion must ship even if a compaction unit conflicts). The silver-hot cron lane
# STAYS as a backstop until a week of in-tick evidence proves this out (do NOT delete it here).
#
# TICK_MAINT_TABLES: comma-separated hot tables to compact after the gold pass. Values may be bare table
# names (resolved against TICK_MAINT_NAMESPACE, default the Silver namespace) OR ns-qualified `ns:table`
# so a Gold hot table can be added later. DEFAULT EMPTY → the hook is a pure no-op (behaviour unchanged
# until prod values set it — the safe default the task requires). Read INSIDE the helper (not at import)
# so tests can monkeypatch os.environ per-case.
def _tick_maint_tables() -> "list[tuple[str, str]]":
    """Parse TICK_MAINT_TABLES → [(namespace, table), …]. Empty/unset → [] (no-op)."""
    raw = (os.environ.get("TICK_MAINT_TABLES") or "").strip()
    if not raw:
        return []
    default_ns = (os.environ.get("TICK_MAINT_NAMESPACE") or _catalog.SILVER_NAMESPACE).strip()
    out: "list[tuple[str, str]]" = []
    for token in raw.split(","):
        token = token.strip()
        if not token:
            continue
        if ":" in token:
            ns, _, tbl = token.partition(":")
            ns, tbl = ns.strip(), tbl.strip()
        else:
            ns, tbl = default_ns, token
        if tbl:
            out.append((ns, tbl))
    return out


def _run_tick_maintenance() -> None:
    """Compact + expire the TICK_MAINT_TABLES hot tables, INSIDE the transform process (single-shot gold
    path) or the resident tick (under the 910005 leader lock — keeps compaction single-writer among
    replicas). Reuses the maintenance client's mb.optimize (COW rewrite, skip-heuristic near-no-op when
    already compacted) + mb.expire (snapshot TTL) — NO duplicated logic.

    FAILURE ISOLATION (mandatory): this ALWAYS returns None. Every table is wrapped (mirroring
    medallion_maintenance.maintain's per-table try/except) inside an OUTER try/except, so neither a
    catalog-connect failure nor a CommitFailedException on one unit can raise into the caller or touch
    the run's exit code. Concurrency with the silver-hot cron lane is already safe: both go through
    _overwrite_with_retry's re-read-and-retry on CommitFailedException, and the loser's next pass is a
    skip-heuristic no-op.

    We do NOT call medallion_maintenance.maintain() — its MAINT_TABLES/NAMESPACES are IMPORT-TIME module
    constants; we call mb.optimize/mb.expire directly per configured table instead.
    """
    tables = _tick_maint_tables()
    if not tables:
        return  # default: no hot tables configured → pure no-op (behaviour unchanged)
    try:
        # The maintenance dir is not on sys.path (run_all only adds HERE + HERE/silver); lazy-insert it
        # so `import _maintenance_base` resolves. Idempotent — a repeated insert is harmless.
        maint_dir = os.path.join(HERE, "maintenance")
        if maint_dir not in sys.path:
            sys.path.insert(0, maint_dir)
        import _maintenance_base as mb  # noqa: E402 — lazy, only when the hook is enabled

        ttl_ms = int(os.environ.get("SNAPSHOT_TTL_MS", str(604_800_000)))  # 7 days, matches maintain()
        cat = mb.pyiceberg_catalog()  # a SEPARATE pyiceberg handle — isolates a wedged maintenance conn
        for namespace, table in tables:
            # One broken table must not abort the sweep — mirror maintain() :102-110.
            try:
                mb.optimize(cat, namespace, table)                # compaction (COW rewrite, skip-safe)
                mb.expire(cat, namespace, table, ttl_ms)          # snapshot expiry + physical S3 sweep
            except Exception as exc:  # noqa: BLE001 — isolate one table; converge next tick
                print(f"[tick-maint] WARN {namespace}.{table}: {exc}", flush=True)
    except Exception as exc:  # noqa: BLE001 — the ENTIRE hook is best-effort; NEVER fails the transform run
        print(f"[tick-maint] WARN hot-table maintenance skipped ({type(exc).__name__}): {exc}", flush=True)
    return None


# ── ADR-0019 WS-1 D1 + WS-4 D7: end-of-tick serving warm-up POSTs (default OFF, fail-open) ───────────
# The writer that just produced fresh marts is the entity that knows they're fresh. At end-of-tick (after
# the Gold pass + tick-compaction) the tick can (D1) signal duckdb-serving to rotate its epoch — so a
# brand-new Gold view is applied within one tick instead of on the slow self-heal clock — and (D7) pre-fill
# the app's hot Redis cache keys BEFORE any user arrives, killing the cold-first-hit at the source.
#
# BOTH are default-OFF (the owner merges the final PR inert) and STRICTLY FAIL-OPEN: a failed POST logs and
# NEVER fails the tick / touches the exit code — exactly mirroring tools/dev/duckdb-refresh.sh's run_cache_bust
# ("cache busting is an optimization; a failure never fails the refresh — TTL is the net"). Flags read INSIDE
# the helpers (not at import) so tests can monkeypatch os.environ per-case.
#
#   DUCKDB_SERVING_ROTATE_ON_SIGNAL   ON → POST {SERVING_INTERNAL_URL}/internal/rotate after the tick.
#   SERVING_WARM_ON_WRITE             ON → POST {CORE_INTERNAL_URL}/internal/serving/warm  after the tick.
#   SERVING_INTERNAL_URL  base of the in-cluster duckdb-serving Service (default http://duckdb-serving:8091).
#   CORE_INTERNAL_URL     base of the in-cluster core Service            (default http://brain-core:3001).
#   SERVING_WARM_TOKEN    the cluster-internal service token core requires on /internal/serving/warm.
#   SERVING_WARM_TIMEOUT_S  per-POST timeout (default 10s) — a slow serving/core must not stall the loop.
def _flag_on(name: str) -> bool:
    """A tick flag is ON iff its env value is a truthy token. DEFAULT OFF for every new flag (ADR-0019
    safe-off doctrine) — an unset/empty/false value keeps today's behaviour verbatim."""
    return os.environ.get(name, "").strip().lower() in ("1", "true", "yes", "on")


def _post_json(url: str, payload: "dict | None", *, headers: "dict | None" = None, timeout_s: float = 10.0):
    """Minimal stdlib POST (no requests dep). Raises on any non-2xx / transport error — the CALLER walls
    it (fail-open). Kept tiny + dependency-free: the transform image ships urllib, not httpx."""
    import urllib.request  # noqa: E402 — lazy, only when a warm hook is enabled

    body = b"" if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=body, method="POST")
    req.add_header("content-type", "application/json")
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout_s) as resp:  # noqa: S310 — in-cluster http to our own svc
        return resp.status, resp.read(512)  # bounded read; we only care about the status


def _run_serving_rotate() -> None:
    """ADR-0019 WS-1 D1: POST /internal/rotate so serving picks up any brand-new Gold view this tick.
    DEFAULT OFF (DUCKDB_SERVING_ROTATE_ON_SIGNAL). FAIL-OPEN: a failed POST logs and returns None — the
    tick's exit code is never touched (the 600s self-heal clock is the backstop). Mirrors run_cache_bust."""
    if not _flag_on("DUCKDB_SERVING_ROTATE_ON_SIGNAL"):
        return None
    base = (os.environ.get("SERVING_INTERNAL_URL") or "http://duckdb-serving:8091").rstrip("/")
    timeout_s = float(os.environ.get("SERVING_WARM_TIMEOUT_S", "10") or "10")
    try:
        status, _ = _post_json(f"{base}/internal/rotate", None, timeout_s=timeout_s)
        print(f'{{"tick":"serving-rotate","ok":true,"status":{status}}}', flush=True)
    except Exception as exc:  # noqa: BLE001 — fail-open: a rotate POST failure NEVER fails the tick
        print(f'{{"tick":"serving-rotate","ok":false,"err":"{str(exc)[:200]}"}}', flush=True)
    return None


def _run_serving_warm() -> None:
    """ADR-0019 WS-4 D7: POST /internal/serving/warm so core pre-fills the hot Redis cache keys (the
    measured slow-cold dataset allowlist × active brands) BEFORE any user arrives. DEFAULT OFF
    (SERVING_WARM_ON_WRITE). FAIL-OPEN: a failed POST logs and returns None — the tick never fails on it
    (the cache TTL + SWR are the net). Body `{"datasets":"all","brands":"all"}` — core owns the allowlist
    + active-brand enumeration + the default window; the tick only pulls the trigger."""
    if not _flag_on("SERVING_WARM_ON_WRITE"):
        return None
    base = (os.environ.get("CORE_INTERNAL_URL") or "http://brain-core:3001").rstrip("/")
    timeout_s = float(os.environ.get("SERVING_WARM_TIMEOUT_S", "10") or "10")
    headers = {}
    token = (os.environ.get("SERVING_WARM_TOKEN") or "").strip()
    if token:
        headers["x-internal-token"] = token
    try:
        status, _ = _post_json(
            f"{base}/internal/serving/warm", {"datasets": "all", "brands": "all"},
            headers=headers, timeout_s=timeout_s,
        )
        print(f'{{"tick":"serving-warm","ok":true,"status":{status}}}', flush=True)
    except Exception as exc:  # noqa: BLE001 — fail-open: a warm POST failure NEVER fails the tick
        print(f'{{"tick":"serving-warm","ok":false,"err":"{str(exc)[:200]}"}}', flush=True)
    return None


def _run_serving_warmup() -> None:
    """End-of-tick serving warm-up: rotate signal (D1) THEN cache warm (D7), in that order — warming a
    hot key is pointless until serving has rotated onto the fresh Gold view. Both individually flagged +
    fail-open; the whole thing is best-effort and returns None regardless."""
    _run_serving_rotate()
    _run_serving_warm()
    return None


class _SharedConn:
    """Proxy over the single DuckDB connection: forwards everything, no-ops close() (the orchestrator owns
    the lifetime), and makes create_function idempotent so a job re-registering a UDF on pass 2 (or a name
    shared across jobs) does not raise 'already exists'."""

    def __init__(self, con):
        object.__setattr__(self, "_con", con)
        # UDF names already registered on the shared connection — the PRE-CHECK for idempotency, so a
        # re-registration (pass 2, or a name shared across jobs) never even reaches DuckDB.
        object.__setattr__(self, "_registered", set())

    def __getattr__(self, name):
        return getattr(self._con, name)

    def close(self):  # per-job close() is a no-op; the orchestrator closes the real connection
        return None

    def create_function(self, name, *args, **kwargs):
        # First registration wins; later ones are no-ops. Set-based pre-check FIRST (robust), then a
        # message-match fallback. NOTE the match text: DuckDB's real duplicate-UDF error says "A function
        # by the name of 'X' is already CREATED, creating multiple functions with the same name is not
        # supported yet" — not "already exists". The first ship matched only "already exists" and
        # silver_touchpoint failed live (sr_murmur_hash3_32 had been registered by silver_sessions
        # earlier in the same process; prod 2026-07-16). Match both phrasings, belt-and-braces.
        if name in self._registered:
            return None
        try:
            result = self._con.create_function(name, *args, **kwargs)
            self._registered.add(name)
            return result
        except Exception as exc:  # noqa: BLE001 — idempotent across jobs/passes; first registration wins
            msg = str(exc).lower()
            if "already created" in msg or "already exists" in msg:
                self._registered.add(name)
                return None
            raise

    def _real_close(self):
        self._con.close()


def _run_job_file(job_path: str) -> None:
    """Execute a job file's __main__ (its run_job call) against the shared connection."""
    runpy.run_path(job_path, run_name="__main__")


TIERS = {
    # tier: (subdir, glob, required[hard-fail, in order], ordered-first[soft-fail, in order], passes)
    "silver": ("silver", "silver_*.py", ["silver_collector_event.py", "silver_order_state.py"], [], 2),
    "gold": (
        "gold", "gold_*.py", ["gold_revenue_ledger.py"],
        ["gold_attribution_credit.py", "gold_marketing_attribution.py", "gold_attribution_paths.py"], 1,
    ),
}


def _patch_connect(shared: "_SharedConn") -> None:
    """Route every job's `_base.connect()` at the shared warm connection. Idempotent — safe to call
    once per single-shot run or once at resident startup."""
    _base.connect = lambda: shared


def _refresh_shared(shared: "_SharedConn") -> None:
    """Wave 3: swap a FRESH `_catalog.connect()` under the same `_SharedConn` proxy so the next tick
    reads current Iceberg snapshot metadata (no stale file handles — the 2026-07-20 revert cause).

    Swaps the inner `_con` in place (so `_patch_connect`'s closure — which returns `shared` — keeps
    working without re-patching) and resets the per-connection UDF registry (a fresh connection has no
    registered functions; jobs re-register on their pass, exactly as on a cold single-shot run). The old
    connection is closed best-effort AFTER the swap so a close error can never strand the tick without a
    live connection. Attach failure PROPAGATES: the caller runs it inside the tick's try/except, so a
    transient catalog blip is logged as a failed tick and retried next interval — never crashes the loop."""
    fresh = _catalog.connect()  # raises on catalog-down → caught by the tick try/except (loop survives)
    old = object.__getattribute__(shared, "_con")
    object.__setattr__(shared, "_con", fresh)
    object.__setattr__(shared, "_registered", set())
    try:
        old.close()
    except Exception:  # noqa: BLE001 — the fresh connection is already live; a stale-close error is moot
        pass


def run_tier(shared: "_SharedConn", tier: str) -> int:
    """Run one tier's chained jobs against an ALREADY-ATTACHED shared connection. Returns the count of
    non-required job failures (0 = clean); a required-job failure raises (hard-fail, matches the bash
    runner). Extracted so BOTH the single-shot `main()` and the resident tick loop reuse identical
    ordering/pass discipline over the same warm connection — no divergent second path."""
    subdir, pattern, required, ordered, passes = TIERS[tier]
    job_dir = os.path.join(HERE, subdir)

    # Tiered gold cadence: the fast lane skips the heavy full-scan marts; the heavy lane runs ONLY them.
    # Applied to required + ordered here; the `rest` glob is filtered symmetrically below. Non-gold tiers
    # and GOLD_LANE="all" are untouched (today's behaviour).
    if tier == "gold" and GOLD_LANE == "fast":
        required = [j for j in required if j not in GOLD_HEAVY_JOBS]
        ordered = [j for j in ordered if j not in GOLD_HEAVY_JOBS]
    elif tier == "gold" and GOLD_LANE == "heavy":
        required = [j for j in required if j in GOLD_HEAVY_JOBS]
        ordered = [j for j in ordered if j in GOLD_HEAVY_JOBS]

    # Required jobs first — hard deps every other job reads; a failure aborts (raises to the caller).
    for req in required:
        print(f"▶ {req} (required)", flush=True)
        _run_job_file(os.path.join(job_dir, req))

    fails = 0

    def run_soft(basename: str) -> bool:
        """Run a soft job; True on success, False on failure (logged). The caller owns the tally so the
        multi-pass rest loop can count only the FINAL (converged) pass — see below."""
        print(f"▶ {basename}", flush=True)
        try:
            _run_job_file(os.path.join(job_dir, basename))
            return True
        except Exception as exc:  # noqa: BLE001 — best-effort; count + continue (matches the bash runner)
            print(f"✗ FAILED: {basename}: {exc}", flush=True)
            return False

    # Ordered-first soft jobs (the gold attribution chain) — each failure counts (they run once).
    for name in ordered:
        if not run_soft(name):
            fails += 1

    # The rest, `passes` times (silver runs twice so a job that reads a not-yet-produced sibling on pass 1
    # converges on pass 2). COUNT ONLY THE FINAL PASS's failures: a cold rebuild fails pass 1 on siblings
    # not yet created (silver_touchpoint, silver_shipment, …) but those jobs succeed on pass 2 once
    # the producers have run. Summing the transient pass-1 failures made a fully-CONVERGED cold-start run
    # exit non-zero — which fails the tier and BLOCKS the downstream gold tier on every post-flush rebuild
    # (prod 2026-07-18: Silver correct, gold starved). The final pass is the authoritative converged state;
    # a job that still fails there is a real, unconverged failure and is counted.
    skip = set(required) | set(ordered)
    # CORE-ONLY: exclude the v4-identity-owned jobs from the silver glob so the core writer never touches
    # an identity-owned Iceberg table (the v4-identity lane is its sole writer). No-op for the gold tier
    # (none of IDENTITY_OWNED_JOBS is a gold_*.py) and no-op when the flag is off (today's behaviour).
    if TRANSFORM_CORE_ONLY:
        skip |= set(IDENTITY_OWNED_JOBS)
    rest = sorted(
        b for b in (os.path.basename(p) for p in glob.glob(os.path.join(job_dir, pattern)))
        if b not in skip and not b.startswith("_")
    )
    # Tiered gold cadence (symmetric with the required/ordered filter above): fast lane drops the heavy
    # marts from the glob; heavy lane keeps ONLY them. No-op for non-gold tiers / GOLD_LANE="all".
    if tier == "gold" and GOLD_LANE == "fast":
        rest = [b for b in rest if b not in GOLD_HEAVY_JOBS]
    elif tier == "gold" and GOLD_LANE == "heavy":
        rest = [b for b in rest if b in GOLD_HEAVY_JOBS]
    rest_fails = 0
    for p in range(1, passes + 1):
        if passes > 1:
            print(f"── {tier} pass {p}/{passes} ──", flush=True)
        rest_fails = 0  # reset each pass; only the last pass's unconverged failures are real
        for b in rest:
            if not run_soft(b):
                rest_fails += 1
    return fails + rest_fails


def main() -> int:
    tier = sys.argv[1] if len(sys.argv) > 1 else "silver"
    if tier == "resident":
        return run_resident()
    if tier not in TIERS:
        print(f"run_all: unknown tier '{tier}' (want: {'/'.join(TIERS)}/resident)", flush=True)
        return 2

    t0 = time.time()
    # ── THE ONE ATTACH: extensions + REST catalog + S3. Every job reuses this connection. ──────────────
    shared = _SharedConn(_catalog.connect())
    _patch_connect(shared)
    try:
        fails = run_tier(shared, tier)
        # Wave 2a: fold hot-table maintenance into the tick. After the gold pass lands all Gold MERGEs
        # (this is the END of the v4-medallion cron's gold-marts step), compact+expire the configured
        # hot tables in-process. Best-effort — never touches `fails`/exit code (see _run_tick_maintenance).
        if tier == "gold":
            _run_tick_maintenance()
            # ADR-0019 WS-1 D1 + WS-4 D7: signal serving to rotate + pre-fill the app's hot cache keys.
            # Both default-OFF + fail-open — never touches `fails`/exit code (mirrors _run_tick_maintenance).
            _run_serving_warmup()
    finally:
        shared._real_close()

    dt = time.time() - t0
    if fails:
        print(f"── {fails} {tier} job(s) failed (rest refreshed) — {dt:.0f}s ──", flush=True)
        return 1
    print(f"── {tier} single-process run OK — {dt:.0f}s ──", flush=True)
    return 0


# ══════════════════════════════════════════════════════════════════════════════════════════════════
# ADR-0016 P2.2 — resident warm micro-batch worker
# ══════════════════════════════════════════════════════════════════════════════════════════════════


class _LoopState:
    """Shared liveness/shutdown flags between the loop thread and the /healthz probe thread. `alive` is
    True while the loop can still do work; `stopping` is set by a signal so the loop drains the current
    tick then exits. Plain flags + a lock — no asyncio, no extra deps (matches the stdlib-only idiom)."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self.alive = True          # False once the loop has exited (health probe → 503)
        self.stopping = False      # True once a signal asked us to drain + stop
        self.ticks = 0             # completed ticks (leader ticks only), for the health body

    def request_stop(self) -> None:
        with self._lock:
            self.stopping = True

    def should_stop(self) -> bool:
        with self._lock:
            return self.stopping

    def mark_dead(self) -> None:
        with self._lock:
            self.alive = False

    def is_alive(self) -> bool:
        with self._lock:
            return self.alive

    def note_tick(self) -> None:
        with self._lock:
            self.ticks += 1


class _LeaderLock:
    """Postgres advisory-lock single-writer gate — the Python mirror of LeaderLock.ts.

    Holds ONE dedicated libpq connection (separate from the DuckDB warm conn; a SESSION advisory lock
    must live on a persistent connection for its whole hold). `try_acquire()` runs pg_try_advisory_lock
    on the fixed key: True = this replica is the leader for THIS tick. `release()` unlocks so any replica
    can win the next tick — best-effort, and the lock also clears if the connection dies. No leader
    election, no death-recovery — whichever replica wins the next tick's lock is that tick's leader.

    Uses psycopg (v3); the DSN is derived from the SAME PG env the transforms use (SILVER_PG_* — set by
    the derive-pg-env helper in prod, defaults to the local dev PG otherwise)."""

    def __init__(self, key: int) -> None:
        self._key = key
        self._conn = None  # lazy: opened on first try_acquire so import never requires a live PG

    def _dsn(self) -> str:
        # Prefer the JDBC-shaped env (SILVER_PG_JDBC_URL/_USER/_PASSWORD) the transforms already read;
        # this is what derive-pg-env.sh exports in prod. Reuse silver_collector_event's exact parser so
        # the DSN shape is identical to the jobs' own PG reads (no second dialect to keep in sync).
        import silver_collector_event as sce  # noqa: E402 — sibling job module (on sys.path via silver/)
        jdbc = os.environ.get("SILVER_PG_JDBC_URL") or os.environ.get(
            "BRONZE_PG_JDBC_URL", "jdbc:postgresql://localhost:5432/brain"
        )
        user = os.environ.get("SILVER_PG_USER") or os.environ.get("BRONZE_PG_USER", "brain")
        password = os.environ.get("SILVER_PG_PASSWORD") or os.environ.get("BRONZE_PG_PASSWORD", "brain")
        rest = jdbc.replace("jdbc:postgresql://", "").replace("postgresql://", "")
        hostport, _, dbname = rest.partition("/")
        dbname = (dbname.split("?")[0] or "brain")
        host, _, port = hostport.partition(":")
        _ = sce  # imported to assert the sibling is importable in this image (parity with the jobs)
        return " ".join([
            f"host={host or 'localhost'}", f"port={port or '5432'}", f"dbname={dbname}",
            f"user={user}", f"password={password}",
        ])

    def _connection(self):
        if self._conn is None or getattr(self._conn, "closed", True):
            import psycopg  # lazy import — only the resident worker needs it
            self._conn = psycopg.connect(self._dsn(), autocommit=True)
        return self._conn

    def try_acquire(self) -> bool:
        conn = self._connection()
        with conn.cursor() as cur:
            cur.execute("SELECT pg_try_advisory_lock(%s)", (self._key,))
            row = cur.fetchone()
        return bool(row and row[0])

    def release(self) -> None:
        # Best-effort: a failed unlock still clears when the connection closes; never let it mask the
        # tick's own error (mirrors LeaderLock.ts's `.catch(() => undefined)`).
        try:
            conn = self._connection()
            with conn.cursor() as cur:
                cur.execute("SELECT pg_advisory_unlock(%s)", (self._key,))
        except Exception as exc:  # noqa: BLE001
            print(f"⚠ leader-lock release failed (clears on conn close): {exc}", flush=True)

    def close(self) -> None:
        try:
            if self._conn is not None and not getattr(self._conn, "closed", True):
                self._conn.close()
        except Exception:  # noqa: BLE001
            pass


def _run_identity_subprocess() -> int:
    """Run the NODE silver-identity job as a subprocess between the warm Python silver and gold stages
    (the chain crosses languages — the identity resolver ships in the stream-worker deployable). Mirrors
    tools/dev/duckdb-refresh.sh's identity stage: continue-on-error (a failure holds the job's watermark;
    the next tick re-processes the idempotent window). Returns the subprocess exit code (0 = ok)."""
    print(f"▶ identity (node subprocess): {SILVER_IDENTITY_CMD}", flush=True)
    try:
        proc = subprocess.run(SILVER_IDENTITY_CMD, shell=True, cwd=_repo_root())  # noqa: S602 — trusted env cmd
        if proc.returncode != 0:
            print(f"✗ identity subprocess FAILED (rc={proc.returncode}) — converge next tick", flush=True)
        return proc.returncode
    except Exception as exc:  # noqa: BLE001 — never let the node step abort the loop
        print(f"✗ identity subprocess errored: {exc} — converge next tick", flush=True)
        return 1


def _repo_root() -> str:
    """db/iceberg/duckdb/run_all.py → repo root (for the pnpm --filter cwd). In the container the node
    cmd is a built dist path with its own cwd, so this is only load-bearing for the dev pnpm default."""
    return os.path.abspath(os.path.join(HERE, "..", "..", ".."))


def run_one_tick(shared: "_SharedConn") -> int:
    """One micro-batch: warm silver → node identity(subprocess) → warm gold, over the shared connection.
    silver_identity_map re-projection is part of the silver tier's `rest` set already (it is a silver_*.py
    job), so running the node identity subprocess between the silver and gold tiers gives gold a map that
    reflects THIS tick's resolutions — matching duckdb-refresh.sh's keystone→silver→identity→gold order.
    Returns total non-required failures across the tick (identity subprocess non-zero counts as 1).

    CORE-ONLY (TRANSFORM_CORE_ONLY): the identity stage is SKIPPED entirely — no node identity subprocess
    and no explicit silver_identity_map re-projection (and run_tier('silver') has already excluded the
    identity-owned jobs). The v4-identity cron is the SOLE identity writer; this core loop only reads the
    LAST-written silver_identity_map in gold. Net core tick = silver(minus identity) → gold. This keeps the
    slow identity resolve off the core path (no re-block) and preserves single-writer per identity table."""
    fails = 0
    fails += run_tier(shared, "silver")
    if not TRANSFORM_CORE_ONLY:
        if _run_identity_subprocess() != 0:
            fails += 1
        # Re-project the graph → Iceberg map on the WARM conn so gold reads this tick's resolutions.
        try:
            _run_job_file(os.path.join(HERE, "silver", "silver_identity_map.py"))
        except Exception as exc:  # noqa: BLE001 — converge next tick
            print(f"✗ FAILED: silver_identity_map.py: {exc}", flush=True)
            fails += 1
    fails += run_tier(shared, "gold")
    # Wave 2a: fold hot-table maintenance into the tick, INSIDE the 910005 leader lock (compaction stays
    # single-writer among replicas). Best-effort — never touches `fails`/exit code.
    _run_tick_maintenance()
    # ADR-0019 WS-1 D1 + WS-4 D7: signal serving to rotate + pre-fill the app's hot cache keys (both
    # default-OFF + fail-open). Runs under the leader lock so exactly one replica warms per tick.
    _run_serving_warmup()
    return fails


def _start_health_server(state: "_LoopState", port: int) -> HTTPServer:
    """Minimal stdlib liveness endpoint on a daemon thread. GET /healthz → 200 while the loop is alive,
    503 once it has exited/is draining — so the k8s livenessProbe restarts a wedged worker."""

    class _Handler(BaseHTTPRequestHandler):
        def do_GET(self):  # noqa: N802 — BaseHTTPRequestHandler contract
            if self.path.rstrip("/") in ("/healthz", "/health", ""):
                alive = state.is_alive() and not state.should_stop()
                code = 200 if alive else 503
                body = json.dumps({"alive": alive, "ticks": state.ticks}).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(body)))
                self.end_headers()
                self.wfile.write(body)
            else:
                self.send_response(404)
                self.end_headers()

        def log_message(self, *_a):  # silence the default per-request stderr spam
            return

    httpd = HTTPServer(("0.0.0.0", port), _Handler)  # noqa: S104 — probed by k8s inside the pod
    threading.Thread(target=httpd.serve_forever, name="healthz", daemon=True).start()
    return httpd


# ── DR-007 P1: boot-time dependency preflight (kills serial failure discovery) ──────────────────────
# The 2026-07-19 resident cutover CrashLooped through FOUR serially-discovered environment gaps
# (missing secret → stale image → no PG env → IRSA trust), each visible only after fixing the prior
# one in prod. This preflight checks EVERY external dependency at boot and reports ALL failures in
# ONE diagnosis before the loop starts — a broken contract is one complete CrashLoop log, not a hunt.
# TRANSFORM_PREFLIGHT=0 disables entirely; TRANSFORM_PREFLIGHT_SKIP="pg,rest,warehouse,env" skips
# individual probes (each read-only). Probes are separate functions so tests can stub them.

def _preflight_enabled() -> bool:
    return os.environ.get("TRANSFORM_PREFLIGHT", "1").strip().lower() not in ("0", "false", "off")


def _preflight_skips() -> set:
    return {t.strip() for t in os.environ.get("TRANSFORM_PREFLIGHT_SKIP", "").split(",") if t.strip()}


def _probe_env() -> list:
    fails = []
    if not os.environ.get("ICEBERG_REST_URI", "").strip():
        fails.append("env: ICEBERG_REST_URI unset — catalog attach would fall back to the dev default")
    if not (os.environ.get("SILVER_PG_JDBC_URL") or os.environ.get("DATABASE_URL_DIRECT")
            or os.environ.get("DATABASE_URL")):
        fails.append("env: no PG source (SILVER_PG_JDBC_URL / DATABASE_URL[_DIRECT]) — derive-pg-env.sh did not run?")
    return fails


def _probe_pg() -> list:
    """Connect + SELECT 1 on the leader-lock DSN (the same derivation _LeaderLock uses)."""
    try:
        import psycopg  # noqa: E402
        dsn = _LeaderLock(LEADER_LOCK_TRANSFORM_WORKER)._dsn()
        with psycopg.connect(dsn, connect_timeout=10) as conn:
            conn.execute("SELECT 1")
        return []
    except Exception as exc:  # noqa: BLE001 — every failure is a diagnosis line, never a crash here
        return [f"pg: leader-lock DSN unreachable — {str(exc)[:160]}"]


def _probe_rest() -> list:
    """GET /v1/config on the Iceberg REST catalog (the attach handshake, without attaching)."""
    try:
        import urllib.request  # noqa: E402
        base = os.environ.get("ICEBERG_REST_URI", "http://iceberg-rest:8181").rstrip("/")
        with urllib.request.urlopen(f"{base}/v1/config", timeout=10) as r:  # noqa: S310 — in-cluster http
            r.read(1)
        return []
    except Exception as exc:  # noqa: BLE001
        return [f"rest: Iceberg REST catalog unreachable — {str(exc)[:160]}"]


def _probe_warehouse(shared) -> list:
    """One tiny scan through the ATTACHED catalog — exercises REST metadata + S3 data-file reads with
    the pod's real credentials (the exact IRSA-403 failure path of 2026-07-19). An absent table is a
    PASS (fresh env — the catalog round-trip itself succeeded); auth/network errors are failures."""
    probe = f"{_catalog.CATALOG}.{_catalog.BRONZE_NAMESPACE}.collector_events_connect"
    try:
        shared.execute(f"SELECT count(*) FROM {probe};").fetchone()
        return []
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)
        if "does not exist" in msg or "not found" in msg.lower():
            return []  # fresh env: catalog answered, table simply absent — the dependency is healthy
        return [f"warehouse: probe read of {probe} failed — {str(exc)[:200]}"]


def _run_preflight(shared) -> int:
    """Run every non-skipped probe, print ONE complete diagnosis. Returns the failure count."""
    if not _preflight_enabled():
        print("▷ preflight: disabled (TRANSFORM_PREFLIGHT=0)", flush=True)
        return 0
    skips = _preflight_skips()
    failures = []
    for name, probe in (("env", _probe_env), ("pg", _probe_pg), ("rest", _probe_rest)):
        if name in skips:
            print(f"▷ preflight: {name} skipped", flush=True)
            continue
        failures += probe()
    if "warehouse" in skips:
        print("▷ preflight: warehouse skipped", flush=True)
    else:
        failures += _probe_warehouse(shared)
    if failures:
        print(f"✗ PREFLIGHT FAILED — {len(failures)} broken dependencies (fix ALL, then redeploy):", flush=True)
        for f in failures:
            print(f"  ✗ {f}", flush=True)
    else:
        print("✓ preflight: env + pg + rest + warehouse OK", flush=True)
    return len(failures)


def run_resident() -> int:
    """The resident warm micro-batch loop (ADR-0016 P2.2). Holds ONE warm DuckDB connection + attached
    catalog across ticks; every TRANSFORM_TICK_MS runs run_one_tick UNDER the leader lock; drains the
    in-flight tick and closes cleanly on SIGTERM/SIGINT."""
    state = _LoopState()

    def _on_signal(signum, _frame):
        print(f"◼ signal {signum} — draining in-flight tick then exiting", flush=True)
        state.request_stop()

    signal.signal(signal.SIGTERM, _on_signal)
    signal.signal(signal.SIGINT, _on_signal)

    httpd = _start_health_server(state, TRANSFORM_WORKER_HEALTH_PORT)
    print(
        f"▶ transform-worker resident: tick={TRANSFORM_TICK_MS}ms health=:{TRANSFORM_WORKER_HEALTH_PORT} "
        f"lock_key={LEADER_LOCK_TRANSFORM_WORKER} "
        f"core_only={'ON (identity owned by v4-identity cron)' if TRANSFORM_CORE_ONLY else 'off'}",
        flush=True,
    )

    # THE ONE ATTACH — held warm for the process lifetime; every tick reuses it (zero per-tick cold start).
    try:
        shared = _SharedConn(_catalog.connect())
    except Exception as exc:  # noqa: BLE001 — DR-007: attach failure is a preflight-grade diagnosis
        print(f"✗ PREFLIGHT FAILED — catalog attach: {str(exc)[:200]}", flush=True)
        return 1
    if _run_preflight(shared) > 0:
        return 1  # CrashLoop with the COMPLETE dependency diagnosis above (DR-007 P1)
    _patch_connect(shared)
    leader = _LeaderLock(LEADER_LOCK_TRANSFORM_WORKER)

    tick_s = TRANSFORM_TICK_MS / 1000.0
    try:
        while not state.should_stop():
            t0 = time.time()
            ran_as_leader = False
            try:
                if leader.try_acquire():
                    ran_as_leader = True
                    # Wave 3: rebuild the attach at the top of every tick so this tick reads CURRENT
                    # snapshot metadata — never a stale file handle from a snapshot Connect/maintenance
                    # has since expired (the 2026-07-20 revert cause). Cheap post-repartition (1-3 file
                    # keystone). Inside the tick try/except: a catalog blip → failed tick, retried next.
                    if RESIDENT_REFRESH_PER_TICK:
                        _refresh_shared(shared)
                    fails = run_one_tick(shared)
                    state.note_tick()
                    dt = time.time() - t0
                    _emit_freshness(shared, dt)
                    status = "OK" if fails == 0 else f"{fails} failed"
                    print(f"── tick {state.ticks} {status} — {dt:.0f}s ──", flush=True)
                else:
                    print("· not leader this tick — skipping (another replica holds the lock)", flush=True)
            except Exception as exc:  # noqa: BLE001 — a tick error must never kill the resident loop
                print(f"✗ tick errored (loop continues): {exc}", flush=True)
            finally:
                if ran_as_leader:
                    leader.release()
            if state.should_stop():
                break
            # Sleep the REMAINDER of the interval (a tick longer than the interval starts the next
            # immediately). Break the sleep into slices so a signal drains within ≤1s, not a full tick.
            remaining = tick_s - (time.time() - t0)
            while remaining > 0 and not state.should_stop():
                slept = min(1.0, remaining)
                time.sleep(slept)
                remaining -= slept
    finally:
        state.mark_dead()
        leader.close()
        shared._real_close()
        try:
            httpd.shutdown()
        except Exception:  # noqa: BLE001
            pass
    print("◼ transform-worker resident stopped (drained + closed)", flush=True)
    return 0


def _emit_freshness(shared: "_SharedConn", tick_seconds: float) -> None:
    """Emit a structured freshness line on tick completion IF trivially available. The authoritative
    Prometheus `medallion_freshness_seconds` gauge is owned by infra/helm/observability/files/
    freshness_exporter.py (it queries duckdb-serving, which the transform worker does NOT attach) — so
    here we only log the tick wall-time as a structured evidence line; we never fabricate a gauge from a
    source we can't read (C2 anti-fantasy doctrine). If the newest silver ingested_at is trivially
    readable on the warm conn, include it as best-effort context."""
    newest = None
    try:
        row = shared.execute(
            f"SELECT epoch(max(ingested_at)) FROM {_catalog.fqtn(_catalog.SILVER_NAMESPACE, 'silver_collector_event')}"
        ).fetchone()
        if row and row[0] is not None:
            newest = max(0.0, time.time() - float(row[0]))
    except Exception:  # noqa: BLE001 — best-effort; absence is honest (never a fabricated number)
        newest = None
    print(
        json.dumps({
            "metric": "transform_worker_tick",
            "tick_seconds": round(tick_seconds, 1),
            "medallion_freshness_seconds": None if newest is None else round(newest, 1),
        }),
        flush=True,
    )


if __name__ == "__main__":
    sys.exit(main())
