"""
engine.py — the epoch-rotating DuckDB engine behind duckdb-serving (plan §A2).

One process holds ONE DuckDB connection attached READ-ONLY to the Iceberg REST catalog as
`iceberg` (env ICEBERG_CATALOG; reuses db/iceberg/duckdb/_catalog.py), with the serving views
applied into LOCAL brain_serving/brain_bronze schemas. Requests run on `con.cursor()` — a
cursor shares the parent's attached catalog AND its local views, and concurrent cursors are
safe (spike gate a) — behind an admission semaphore, with a threading.Timer→cur.interrupt()
watchdog so a pathological query degrades to a clean timeout error, never an OOM-killed pod.

EPOCH ROTATION (self-heal, NOT freshness): a live attach already sees new Iceberg commits on
plain re-query — no re-attach needed (spike gate b) — so rotation exists only to (1) re-apply
views that were skipped because their Gold mart didn't exist yet (continue-on-error parity
with run-trino-views.sh) and (2) recover from a poisoned attach. Hence the LONG default,
DUCKDB_SERVING_CATALOG_REFRESH_S=900. Rotation builds a NEW epoch, atomically swaps it in,
and retires the old one once its in-flight cursors drain. While no epoch is live (cold start
with the catalog down), the rotation thread retries on a short 15s cadence instead.

STATEMENT GUARD: only SELECT/WITH statements are accepted (single statement — no `;` chains),
scanned with string-literal/comment awareness. Defense-in-depth beneath it: the catalog attach
itself is READ_ONLY (spike gate c), so even a guard escape cannot write Iceberg.

Env (plan §A):
  DUCKDB_SERVING_MEMORY_LIMIT            per-replica DuckDB memory_limit     (default 3GB)
  DUCKDB_SERVING_THREADS                 DuckDB threads                      (default 4)
  DUCKDB_SERVING_TEMP_DIRECTORY          spill dir                           (default /tmp/duckdb-serving-spill)
  DUCKDB_SERVING_MAX_TEMP_DIRECTORY_SIZE spill cap                           (default 5GB)
  DUCKDB_SERVING_MAX_CONCURRENT          admission semaphore width           (default 8)
  STATEMENT_TIMEOUT_MS                   interrupt watchdog (< the TS adapter's 30s abort) (default 25000)
  DUCKDB_SERVING_CATALOG_REFRESH_S       epoch rotation period               (default 900 — spike gate b)
  + the _catalog.py family (ICEBERG_CATALOG/ICEBERG_REST_URI/ICEBERG_WAREHOUSE/S3_ENDPOINT/…)
"""
from __future__ import annotations

import os
import sys
import threading

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
sys.path.insert(0, os.path.dirname(HERE))  # _catalog.py lives one level up (transform-tier seam)

import _catalog  # noqa: E402
import views as views_mod  # noqa: E402

MEMORY_LIMIT = os.environ.get("DUCKDB_SERVING_MEMORY_LIMIT", "3GB")
THREADS = int(os.environ.get("DUCKDB_SERVING_THREADS", "4") or "4")
TEMP_DIRECTORY = os.environ.get("DUCKDB_SERVING_TEMP_DIRECTORY", "/tmp/duckdb-serving-spill")
MAX_TEMP_DIRECTORY_SIZE = os.environ.get("DUCKDB_SERVING_MAX_TEMP_DIRECTORY_SIZE", "5GB")
MAX_CONCURRENT = int(os.environ.get("DUCKDB_SERVING_MAX_CONCURRENT", "8") or "8")
STATEMENT_TIMEOUT_MS = int(os.environ.get("STATEMENT_TIMEOUT_MS", "25000") or "25000")
CATALOG_REFRESH_S = int(os.environ.get("DUCKDB_SERVING_CATALOG_REFRESH_S", "900") or "900")
# Admission wait: a request queues briefly for a semaphore slot, then 503s — the TS adapter
# aborts at 30s, so queueing long merely converts saturation into timeouts. Short and fixed.
ADMISSION_WAIT_S = 2.0
# Cold-start/self-heal retry cadence while NO epoch is live (catalog down at boot).
BOOTSTRAP_RETRY_S = 15.0


class QueryRejected(Exception):
    """Statement failed the SELECT/WITH-only guard (→ HTTP 400)."""


class QueryTimeout(Exception):
    """Watchdog interrupted the statement at STATEMENT_TIMEOUT_MS (→ HTTP 504)."""


class EngineSaturated(Exception):
    """No admission-semaphore slot within ADMISSION_WAIT_S (→ HTTP 503)."""


class EngineNotReady(Exception):
    """No live epoch yet — catalog attach hasn't succeeded (→ HTTP 503)."""


def guard_statement(sql: str) -> None:
    """
    Reject anything that is not ONE bare SELECT/WITH statement. Scans with string-literal and
    comment awareness ('--'/'/*' inside a literal are data; ';' inside a literal is data), so:
      - first effective keyword must be SELECT or WITH,
      - no second statement (no ';' outside literals except trailing),
    Raises QueryRejected. The READ_ONLY catalog attach backstops this guard.
    """
    effective: list[str] = []
    i, n = 0, len(sql)
    in_str = False
    while i < n:
        ch = sql[i]
        if in_str:
            # Literal CONTENT is masked (only the closing quote survives) so a ';'/'--' inside a
            # string can never trip the multi-statement / comment scanning below — it is data.
            if ch == "'":
                effective.append(ch)
                in_str = False  # a doubled '' toggles out then straight back in — correct either way
            else:
                effective.append("_")
            i += 1
            continue
        if ch == "'":
            in_str = True
            effective.append(ch)
            i += 1
            continue
        if ch == "-" and sql.startswith("--", i):
            j = sql.find("\n", i)
            i = n if j < 0 else j  # keep the newline as a token separator
            continue
        if ch == "/" and sql.startswith("/*", i):
            j = sql.find("*/", i + 2)
            if j < 0:
                raise QueryRejected("unterminated block comment")
            effective.append(" ")
            i = j + 2
            continue
        effective.append(ch)
        i += 1
    text = "".join(effective).strip()
    # Trailing semicolons are tolerated (the adapter strips them, but be lenient); any OTHER
    # semicolon means a second statement — rejected (a cursor would execute the whole chain).
    while text.endswith(";"):
        text = text[:-1].rstrip()
    if not text:
        raise QueryRejected("empty statement")
    if ";" in text:
        raise QueryRejected("multiple statements are not allowed")
    first = text.split(None, 1)[0].upper().split("(")[0]
    if first not in ("SELECT", "WITH"):
        raise QueryRejected(f"only SELECT/WITH statements are served (got '{first}')")


class Epoch:
    """One attached connection + its applied views, refcounted so rotation can retire it only
    after every in-flight cursor drains (close-under-a-running-query is a crash, not an error)."""

    def __init__(self, index: int, views_dir: str | None):
        self.index = index
        self.con = _catalog.connect(read_only=True)
        # GOTCHA (caught live in the smoke run): _catalog.connect()'s `SET TimeZone='UTC'` is
        # SESSION-LOCAL and cursors do NOT inherit it — a request cursor parsed TIMESTAMPTZ
        # literals in the HOST timezone and shifted every timestamptz comparison/rendering.
        # SET GLOBAL propagates to every cursor (verified: local stays host-TZ on the cursor,
        # GLOBAL is UTC on both). The serving process owns this database instance, so GLOBAL
        # is safe. Spike gate e's correctness holds ONLY under a UTC session.
        self.con.execute("SET GLOBAL TimeZone='UTC';")
        # Resource pragmas BEFORE any view/query work: a bounded replica degrades (spill, then a
        # clean OOM error on the one query) instead of taking the pod down.
        os.makedirs(TEMP_DIRECTORY, exist_ok=True)
        self.con.execute(f"SET memory_limit='{MEMORY_LIMIT}';")
        self.con.execute(f"SET threads={THREADS};")
        self.con.execute(f"SET temp_directory='{TEMP_DIRECTORY}';")
        self.con.execute(f"SET max_temp_directory_size='{MAX_TEMP_DIRECTORY_SIZE}';")
        self.views_applied, self.views_skipped = views_mod.apply_views(self.con, views_dir)
        self._lock = threading.Lock()
        self._refs = 0
        self._retired = False

    def acquire(self) -> bool:
        with self._lock:
            if self._retired:
                return False
            self._refs += 1
            return True

    def release(self) -> None:
        close = False
        with self._lock:
            self._refs -= 1
            close = self._retired and self._refs == 0
        if close:
            self.con.close()

    def retire(self) -> None:
        close = False
        with self._lock:
            self._retired = True
            close = self._refs == 0
        if close:
            self.con.close()


class Engine:
    """The serving engine: current epoch + admission semaphore + rotation thread + counters."""

    def __init__(self, views_dir: str | None = None):
        self._views_dir = views_dir
        self._epoch: Epoch | None = None
        self._epoch_lock = threading.Lock()
        self._epoch_seq = 0
        self._sem = threading.Semaphore(MAX_CONCURRENT)
        self._stop = threading.Event()
        self._rotator: threading.Thread | None = None
        # Prometheus counters (exposed by server.py /metrics; plain ints under the GIL are fine
        # for monotonic counters — a lost increment under contention is a rounding error, not a lie).
        self.queries_total = 0
        self.query_failures_total = 0
        self.query_timeouts_total = 0
        self.query_rejected_total = 0
        self.query_saturated_total = 0
        self.rotations_total = 0
        self.rotation_failures_total = 0
        self.inflight = 0

    # ── lifecycle ──────────────────────────────────────────────────────────────────────────────

    def start(self) -> None:
        """Best-effort first epoch (a down catalog must NOT crash the pod — /readyz stays 503 and
        the rotation thread keeps retrying on the bootstrap cadence), then the rotation thread."""
        try:
            self.rotate_once()
        except Exception as exc:  # noqa: BLE001 — cold start with catalog down: retry, don't die
            print(f"engine: first epoch build failed (will retry every {BOOTSTRAP_RETRY_S:.0f}s): {exc}",
                  flush=True)
        self._rotator = threading.Thread(target=self._rotate_loop, name="epoch-rotator", daemon=True)
        self._rotator.start()

    def stop(self) -> None:
        self._stop.set()
        with self._epoch_lock:
            old, self._epoch = self._epoch, None
        if old is not None:
            old.retire()

    def rotate_once(self) -> None:
        """Build a NEW epoch (attach + pragmas + views), atomically swap it in, retire the old.
        On build failure the CURRENT epoch keeps serving — rotation is self-heal, not a risk."""
        self._epoch_seq += 1
        try:
            fresh = Epoch(self._epoch_seq, self._views_dir)
        except Exception:
            self.rotation_failures_total += 1
            raise
        with self._epoch_lock:
            old, self._epoch = self._epoch, fresh
        self.rotations_total += 1
        if old is not None:
            old.retire()
        print(f'{{"engine":"duckdb-serving","epoch":{fresh.index},"views_applied":{fresh.views_applied},'
              f'"views_skipped":{len(fresh.views_skipped)}}}', flush=True)

    def _rotate_loop(self) -> None:
        while not self._stop.is_set():
            wait = CATALOG_REFRESH_S if self._epoch is not None else BOOTSTRAP_RETRY_S
            if self._stop.wait(wait):
                return
            try:
                self.rotate_once()
            except Exception as exc:  # noqa: BLE001 — keep serving on the old epoch; retry next tick
                print(f"engine: epoch rotation failed (serving continues on old epoch): {exc}", flush=True)

    # ── serving ────────────────────────────────────────────────────────────────────────────────

    def query(self, sql: str):
        """
        Run one guarded SELECT/WITH on a fresh cursor of the current epoch, under the admission
        semaphore, with the interrupt watchdog. Returns (description, rows) for serialize.py.
        Raises QueryRejected / EngineNotReady / EngineSaturated / QueryTimeout / duckdb errors.
        """
        try:
            guard_statement(sql)
        except QueryRejected:
            self.query_rejected_total += 1
            raise
        if not self._sem.acquire(timeout=ADMISSION_WAIT_S):
            self.query_saturated_total += 1
            raise EngineSaturated(f"no slot within {ADMISSION_WAIT_S:.0f}s ({MAX_CONCURRENT} concurrent)")
        try:
            with self._epoch_lock:
                epoch = self._epoch
                if epoch is None or not epoch.acquire():
                    raise EngineNotReady("no live epoch (catalog attach pending)")
            try:
                return self._run_on_epoch(epoch, sql)
            finally:
                epoch.release()
        finally:
            self._sem.release()

    def _run_on_epoch(self, epoch: Epoch, sql: str):
        import duckdb  # lazy, mirrors _catalog.py

        self.inflight += 1
        self.queries_total += 1
        cur = epoch.con.cursor()  # cursor-per-request: shares the attach + local views (spike gate a)
        timed_out = threading.Event()

        def _interrupt() -> None:
            timed_out.set()
            try:
                cur.interrupt()
            except Exception:  # noqa: BLE001 — cursor may already be closed; watchdog is best-effort
                pass

        watchdog = threading.Timer(STATEMENT_TIMEOUT_MS / 1000.0, _interrupt)
        watchdog.daemon = True
        watchdog.start()
        try:
            cur.execute(sql)
            description = cur.description or []
            rows = cur.fetchall()
            return description, rows
        except duckdb.InterruptException as exc:
            self.query_timeouts_total += 1
            raise QueryTimeout(f"statement interrupted at {STATEMENT_TIMEOUT_MS}ms") from exc
        except Exception:
            # The interrupt can surface as a non-InterruptException error depending on the phase it
            # lands in — classify by the watchdog flag so a timeout is never reported as a 500.
            if timed_out.is_set():
                self.query_timeouts_total += 1
                raise QueryTimeout(f"statement interrupted at {STATEMENT_TIMEOUT_MS}ms") from None
            self.query_failures_total += 1
            raise
        finally:
            watchdog.cancel()
            self.inflight -= 1
            try:
                cur.close()
            except Exception:  # noqa: BLE001
                pass

    # ── introspection (readyz / metrics) ───────────────────────────────────────────────────────

    def status(self) -> dict:
        with self._epoch_lock:
            epoch = self._epoch
        if epoch is None:
            return {"ready": False, "epoch": None, "views_applied": 0, "views_skipped": []}
        return {
            "ready": True,
            "epoch": epoch.index,
            "views_applied": epoch.views_applied,
            "views_skipped": list(epoch.views_skipped),
        }
