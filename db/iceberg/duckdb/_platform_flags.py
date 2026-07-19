# SPEC: 0.5
"""
_platform_flags.py — Python twin of @brain/platform-flags for Spark jobs (READ-ONLY).

Spark-side gate for per-brand feature flags (e.g. stitch v2 reads `stitch.v2` before
emitting the new tables for a brand). Reads the SAME Redis keys the TypeScript service
writes — keep in lockstep with packages/platform-flags:

    key      : f"{brand_id}:flag:{flag}"            (brand_id FIRST — §0.5 tenant rule;
                                                     TS builder: tenant-context flagKey())
    enabled  : the stored value is the literal string 'true'. Anything else — absent,
               'false', garbage — is DISABLED (default OFF).
    failure  : FAIL-CLOSED. Redis down / timeout / bad URL / any exception → False →
               the job runs pre-wave behavior. A flag read never raises into a job.

Zero dependencies by design: the Spark image (Python 3.8) ships no redis-py, so this
module speaks minimal RESP2 (AUTH/SELECT/GET) over a plain socket with short timeouts.
Writes stay TypeScript-only (the admin BFF surface) — Spark never sets flags.

Usage in a Spark job:
    from _platform_flags import is_flag_enabled
    if is_flag_enabled(brand_id, "stitch.v2"):
        ...  # new (flagged) path
    else:
        ...  # pre-wave path

Remember to spark.sparkContext.addPyFile(".../_platform_flags.py") if the check runs
inside executors (the known UDF-helper gotcha); driver-side gating needs no addPyFile.
"""
from __future__ import annotations  # Python 3.8 on the Spark image.

import os
import socket

# Mirror of the Wave-A flag names Spark jobs read (TS registry is the source of truth:
# packages/platform-flags/src/registry.ts). Informational — unknown names simply read False.
FLAG_STITCH_V2 = "stitch.v2"
FLAG_IDENTITY_PROBABILISTIC = "identity.probabilistic"
# SPEC: B.1 — canonical journey generation reads silver_session_identity (Stitch v2) as its identity
# resolution input when this per-brand flag is ON; OFF (default) keeps the legacy silver_touchpoint
# stitched_brain_id input, byte-identical to pre-wave (AMD-13 R1).
FLAG_JOURNEY_ENGINE = "journey.engine"
# C.2.6 measurement.inventory_movement RETIRED by DR-002 (inventory movement fact + source deleted).
# SPEC: A.2.2 / audit-G1 — per-brand gate for QUERY-TIME, MULTI-KEY (email+phone+platform_customer_id),
# bi-temporal (identity_current), merge-aware brain_id resolution on the REVENUE spine. OFF (default) →
# the additive brain_id_v2 column is NULL and the legacy flat single-key brain_id is byte-identical to
# pre-wave (parity preserved). ON for a brand → brain_id_v2 is populated for parallel-run comparison.
FLAG_IDENTITY_REVENUE_QUERYTIME = "identity.revenue_querytime"

_ENABLED_VALUE = b"true"
_DEFAULT_REDIS_URL = "redis://localhost:6379"
_DEFAULT_TIMEOUT_SECONDS = 2.0


def flag_key(brand_id: str, flag: str) -> str:
    """The brand-first flag key — byte-identical to tenant-context flagKey() in TS.

    Raises ValueError on empty segments or ':' injection (callers wanting fail-closed
    reads should use is_flag_enabled, which catches everything)."""
    if not brand_id:
        raise ValueError("flag_key: brand_id is required")
    if not flag:
        raise ValueError("flag_key: flag is required")
    if ":" in brand_id or ":" in flag:
        raise ValueError("flag_key: segments must not contain ':'")
    return "{0}:flag:{1}".format(brand_id, flag)


def _parse_redis_url(url: str):
    """redis://[:password@]host[:port][/db] → (host, port, password, db). Minimal on purpose."""
    rest = url
    if rest.startswith("redis://"):
        rest = rest[len("redis://"):]
    elif rest.startswith("rediss://"):
        # TLS Redis is not used in this stack; treated as a plain host (local/dev only).
        rest = rest[len("rediss://"):]
    password = None
    if "@" in rest:
        auth, rest = rest.rsplit("@", 1)
        if ":" in auth:  # user:password (user ignored — Redis AUTH default user)
            password = auth.split(":", 1)[1]
        else:
            password = auth or None
    db = 0
    if "/" in rest:
        rest, db_part = rest.split("/", 1)
        if db_part.strip():
            db = int(db_part.strip())
    host, port = rest, 6379
    if ":" in rest:
        host, port_part = rest.split(":", 1)
        port = int(port_part)
    return host or "localhost", port, password, db


def _encode_command(args) -> bytes:
    """RESP2 array-of-bulk-strings encoding for one command."""
    out = [b"*" + str(len(args)).encode("ascii") + b"\r\n"]
    for arg in args:
        data = arg if isinstance(arg, bytes) else str(arg).encode("utf-8")
        out.append(b"$" + str(len(data)).encode("ascii") + b"\r\n" + data + b"\r\n")
    return b"".join(out)


def _read_reply(reader):
    """Parse ONE RESP2 reply from a file-like binary reader.

    Returns bytes (bulk/simple), int, None (null bulk), or raises on -ERR / EOF.
    Only the types AUTH/SELECT/GET can produce are handled — this is not a client library."""
    line = reader.readline()
    if not line:
        raise ConnectionError("redis: connection closed mid-reply")
    prefix, body = line[:1], line[1:].rstrip(b"\r\n")
    if prefix == b"+":  # simple string, e.g. +OK
        return body
    if prefix == b"-":  # error
        raise ConnectionError("redis error reply: {0}".format(body.decode("utf-8", "replace")))
    if prefix == b":":  # integer
        return int(body)
    if prefix == b"$":  # bulk string
        length = int(body)
        if length == -1:
            return None  # null bulk — key absent
        data = reader.read(length + 2)  # payload + trailing \r\n
        if data is None or len(data) < length + 2:
            raise ConnectionError("redis: short bulk read")
        return data[:length]
    raise ConnectionError("redis: unexpected reply prefix {0!r}".format(prefix))


def _redis_get(url: str, key: str, timeout_seconds: float):
    """One-shot GET over a fresh socket (flag reads are rare — once per job/brand)."""
    host, port, password, db = _parse_redis_url(url)
    sock = socket.create_connection((host, port), timeout=timeout_seconds)
    try:
        sock.settimeout(timeout_seconds)
        reader = sock.makefile("rb")
        try:
            if password:
                sock.sendall(_encode_command(["AUTH", password]))
                _read_reply(reader)
            if db:
                sock.sendall(_encode_command(["SELECT", str(db)]))
                _read_reply(reader)
            sock.sendall(_encode_command(["GET", key]))
            return _read_reply(reader)
        finally:
            reader.close()
    finally:
        sock.close()


def is_flag_enabled(brand_id: str, flag: str, redis_url: str = None,
                    timeout_seconds: float = _DEFAULT_TIMEOUT_SECONDS) -> bool:
    """Is `flag` enabled for `brand_id`? DEFAULT OFF, FAIL-CLOSED — mirrors the TS
    FlagService.isFlagEnabled semantics exactly. NEVER raises.

    redis_url defaults to $REDIS_URL (compose/k8s convention, same var the TS apps use),
    falling back to redis://localhost:6379.
    """
    try:
        if not brand_id or not flag:
            return False
        key = flag_key(brand_id, flag)
        url = redis_url or os.environ.get("REDIS_URL") or _DEFAULT_REDIS_URL
        value = _redis_get(url, key, timeout_seconds)
        return value == _ENABLED_VALUE
    except Exception:
        return False  # FAIL-CLOSED: any failure → pre-wave behavior.
