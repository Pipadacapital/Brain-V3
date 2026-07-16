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

FLAG: invoked only when the template's single-process path is enabled (values `sparkV4.singleProcess`);
the old 90-spawn bash loop remains the default until this is validated on one prod run. Usage:
    python run_all.py silver     # keystone+spine required, then 2 passes over the rest
    python run_all.py gold        # revenue_ledger required, attribution chain, then the rest (1 pass)
Exit 1 if any non-required job failed (best-effort, matches the bash runner); a required job aborts hard.
"""
from __future__ import annotations

import glob
import os
import runpy
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.join(HERE, "silver"))  # _normalize_base lives under silver/

import _base  # noqa: E402
import _catalog  # noqa: E402


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


def main() -> int:
    tier = sys.argv[1] if len(sys.argv) > 1 else "silver"
    if tier not in TIERS:
        print(f"run_all: unknown tier '{tier}' (want: {'/'.join(TIERS)})", flush=True)
        return 2
    subdir, pattern, required, ordered, passes = TIERS[tier]
    job_dir = os.path.join(HERE, subdir)

    t0 = time.time()
    # ── THE ONE ATTACH: extensions + REST catalog + S3. Every job reuses this connection. ──────────────
    shared = _SharedConn(_catalog.connect())
    _base.connect = lambda: shared
    try:  # _normalize_base is optional (silver-only); patch its connect too when present
        import _normalize_base  # noqa: E402
        _normalize_base.connect = lambda: shared
    except Exception:  # noqa: BLE001
        pass

    try:
        # Required jobs first — hard deps every other job reads; a failure aborts the run (exit≠0).
        for req in required:
            print(f"▶ {req} (required)", flush=True)
            _run_job_file(os.path.join(job_dir, req))

        fails = 0

        def run_soft(basename: str) -> None:
            nonlocal fails
            print(f"▶ {basename}", flush=True)
            try:
                _run_job_file(os.path.join(job_dir, basename))
            except Exception as exc:  # noqa: BLE001 — best-effort; count + continue (matches the bash runner)
                print(f"✗ FAILED: {basename}: {exc}", flush=True)
                fails += 1

        # Ordered-first soft jobs (the gold attribution chain).
        for name in ordered:
            run_soft(name)

        # The rest, `passes` times (silver runs twice so a job that read a not-yet-produced sibling on pass
        # 1 converges on pass 2 — unchanged from the bash runner; cheap now that there is no per-job attach).
        skip = set(required) | set(ordered)
        rest = sorted(
            b for b in (os.path.basename(p) for p in glob.glob(os.path.join(job_dir, pattern)))
            if b not in skip and not b.startswith("_")
        )
        for p in range(1, passes + 1):
            if passes > 1:
                print(f"── {tier} pass {p}/{passes} ──", flush=True)
            for b in rest:
                run_soft(b)
    finally:
        shared._real_close()

    dt = time.time() - t0
    if fails:
        print(f"── {fails} {tier} job(s) failed (rest refreshed) — {dt:.0f}s ──", flush=True)
        return 1
    print(f"── {tier} single-process run OK — {dt:.0f}s ──", flush=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
