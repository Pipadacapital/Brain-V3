"""
run_all.py — Phase 1d: the SINGLE-PROCESS transform runner.

WHY: prod telemetry (2026-07-16) showed every DuckDB job costs ~85s of FIXED per-process overhead
(Python + DuckDB startup + Iceberg REST-catalog ATTACH + S3/IRSA setup) — the keystone that scans ALL of
Bronze and the leaf that reads a tiny slice and upserts ZERO both take ~85-92s. The old runner spawns 90
processes per run (45 jobs × 2 passes), so a `*/5` run takes ~130 min — the scan/rows were never the
bottleneck, the process count was. This runner attaches the catalog ONCE and runs every job's existing
`__main__` (its `run_job`/`run_normalize_job` call) against ONE shared connection, collapsing ~90 attaches
into one. Expected: ~130 min → ~single-digit minutes, so the `*/5` schedule finally delivers realtime.

HOW: we do NOT rewrite the 90 jobs. We reuse each job file verbatim by executing its `__main__` via runpy,
after patching `_base.connect` / `_normalize_base.connect` to hand every `run_job` the SAME connection
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
sys.path.insert(0, os.path.join(HERE, "silver"))  # _normalize_base lives under silver/

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
    """Execute a job file's __main__ (its run_job/run_normalize_job call) against the shared connection."""
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
    """Route every job's `_base.connect()` (and `_normalize_base.connect()` when present) at the shared
    warm connection. Idempotent — safe to call once per single-shot run or once at resident startup."""
    _base.connect = lambda: shared
    try:  # _normalize_base is optional (silver-only); patch its connect too when present
        import _normalize_base  # noqa: E402
        _normalize_base.connect = lambda: shared
    except Exception:  # noqa: BLE001
        pass


def run_tier(shared: "_SharedConn", tier: str) -> int:
    """Run one tier's chained jobs against an ALREADY-ATTACHED shared connection. Returns the count of
    non-required job failures (0 = clean); a required-job failure raises (hard-fail, matches the bash
    runner). Extracted so BOTH the single-shot `main()` and the resident tick loop reuse identical
    ordering/pass discipline over the same warm connection — no divergent second path."""
    subdir, pattern, required, ordered, passes = TIERS[tier]
    job_dir = os.path.join(HERE, subdir)

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
    # not yet created (silver_touchpoint, silver_shipment_event, …) but those jobs succeed on pass 2 once
    # the producers have run. Summing the transient pass-1 failures made a fully-CONVERGED cold-start run
    # exit non-zero — which fails the tier and BLOCKS the downstream gold tier on every post-flush rebuild
    # (prod 2026-07-18: Silver correct, gold starved). The final pass is the authoritative converged state;
    # a job that still fails there is a real, unconverged failure and is counted.
    skip = set(required) | set(ordered)
    rest = sorted(
        b for b in (os.path.basename(p) for p in glob.glob(os.path.join(job_dir, pattern)))
        if b not in skip and not b.startswith("_")
    )
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
    Returns total non-required failures across the tick (identity subprocess non-zero counts as 1)."""
    fails = 0
    fails += run_tier(shared, "silver")
    if _run_identity_subprocess() != 0:
        fails += 1
    # Re-project the graph → Iceberg map on the WARM conn so gold reads this tick's resolutions.
    try:
        _run_job_file(os.path.join(HERE, "silver", "silver_identity_map.py"))
    except Exception as exc:  # noqa: BLE001 — converge next tick
        print(f"✗ FAILED: silver_identity_map.py: {exc}", flush=True)
        fails += 1
    fails += run_tier(shared, "gold")
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
        f"lock_key={LEADER_LOCK_TRANSFORM_WORKER}",
        flush=True,
    )

    # THE ONE ATTACH — held warm for the process lifetime; every tick reuses it (zero per-tick cold start).
    shared = _SharedConn(_catalog.connect())
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
