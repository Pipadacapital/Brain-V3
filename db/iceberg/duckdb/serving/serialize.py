"""
serialize.py — DuckDB result values → Trino-shaped JSON (duckdb-serving, plan §A2).

The TS adapter consumed Trino's REST rendering for years; every BFF/contract parser is
calibrated to THOSE string/number shapes (two prior engine swaps — StarRocks→Trino — were
littered with silent rendering drift). This module is the ONE place duckdb-serving decides
how a Python value from `cursor.fetchall()` becomes JSON, so the wire format is pinned by
unit tests instead of re-discovered endpoint-by-endpoint.

Type table (the plan's contract; matches what Trino sent the TS adapter):
  NULL                  → null
  BOOLEAN               → true / false               (checked BEFORE int — bool is an int subclass)
  BIGINT/HUGEINT (int)  → JSON number when |v| ≤ 2^53, else STRING. Money is BIGINT minor
                          units and a SUM() promotes to HUGEINT — above 2^53 a JSON number
                          round-trips through IEEE-754 double and silently corrupts paise.
  DOUBLE/FLOAT          → JSON number; NaN/±Inf → null (JSON has no NaN literal)
  DECIMAL               → string (Trino renders decimals as strings — exactness over ergonomics)
  DATE                  → 'YYYY-MM-DD'
  TIMESTAMP             → 'YYYY-MM-DD HH:MM:SS.ffffff'        (Trino timestamp(6) rendering)
  TIMESTAMPTZ           → 'YYYY-MM-DD HH:MM:SS.ffffff UTC'    (UTC-normalized). NOTE: DuckDB's
                          Python value str()s as '…+00:00' which is NOT Trino's rendering
                          (spike gate e) — so we format EXPLICITLY, never str().
  TIME                  → 'HH:MM:SS.ffffff'
  UUID                  → string
  BLOB/VARBINARY        → base64 string (Trino's varbinary rendering)
  INTERVAL              → str(timedelta) (no serving read returns intervals today; defined for safety)
  LIST                  → JSON array, elements recursed
  STRUCT/MAP            → JSON object, values recursed (self-describing named fields — the
                          journey Sankey `edges` LIST<STRUCT> consumer reads field names)

Anything else fails LOUD (TypeError) — an unmapped type must be added here consciously,
never silently str()'d into a plausible-but-undefined wire shape.
"""
from __future__ import annotations

import base64
import datetime
import math
import uuid
from decimal import Decimal

# IEEE-754 double integer-exactness bound: |v| ≤ 2^53 round-trips JSON→JS number losslessly.
# Above it, emit a string and let the TS side BigInt() it (bigint-safe money discipline, I-S07).
JS_MAX_SAFE_INT = 2**53


def serialize_value(v):
    """One Python value from a DuckDB cursor → its JSON-safe (Trino-shaped) representation."""
    if v is None:
        return None
    # bool BEFORE int: isinstance(True, int) is True, and True must serialize as JSON true, not 1.
    if isinstance(v, bool):
        return v
    if isinstance(v, int):
        return v if -JS_MAX_SAFE_INT <= v <= JS_MAX_SAFE_INT else str(v)
    if isinstance(v, float):
        return None if (math.isnan(v) or math.isinf(v)) else v
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, str):
        return v
    # datetime BEFORE date: datetime is a date subclass — the date branch would swallow timestamps.
    if isinstance(v, datetime.datetime):
        if v.tzinfo is not None:
            # TIMESTAMPTZ: normalize to a UTC instant, render with Trino's ' UTC' suffix.
            v = v.astimezone(datetime.timezone.utc)
            return v.strftime("%Y-%m-%d %H:%M:%S.%f") + " UTC"
        return v.strftime("%Y-%m-%d %H:%M:%S.%f")
    if isinstance(v, datetime.date):
        return v.isoformat()
    if isinstance(v, datetime.time):
        return v.isoformat()
    if isinstance(v, datetime.timedelta):
        return str(v)
    if isinstance(v, uuid.UUID):
        return str(v)
    if isinstance(v, (bytes, bytearray)):
        return base64.b64encode(bytes(v)).decode("ascii")
    if isinstance(v, (list, tuple)):
        return [serialize_value(x) for x in v]
    if isinstance(v, dict):
        return {k: serialize_value(x) for k, x in v.items()}
    raise TypeError(f"serialize: unmapped DuckDB value type {type(v).__name__!r} — add it to the type table")


def serialize_rows(rows):
    """fetchall() → Trino-shaped `data` (array of arrays, values serialized per the type table)."""
    return [[serialize_value(v) for v in row] for row in rows]


def columns_of(description):
    """cursor.description → Trino-shaped `columns` ([{name, type}]). The TS adapter binds rows to
    objects by NAME only (type is informational), so the type string is DuckDB's, lowercased."""
    return [{"name": d[0], "type": str(d[1]).lower()} for d in description]
