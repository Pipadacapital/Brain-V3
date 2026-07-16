"""test_serialize.py — the duckdb-serving wire format (pure unit; no stack).

Pins the Trino-shaped rendering the TS adapter/BFF depends on — ESPECIALLY the 2^53 money
boundary (a HUGEINT SUM(realized_minor) above 2^53 must serialize as a STRING, never round
through a JSON double) and the TIMESTAMPTZ ' UTC' suffix (DuckDB's own str() renders
'…+00:00', which is NOT what the app parses — spike gate e).

The last test runs the whole table through a REAL in-memory DuckDB cursor (local, no
network) so `columns_of`/`serialize_rows` are proven against actual driver value types.
Run: python -m pytest db/iceberg/duckdb/serving/test_serialize.py
"""
from __future__ import annotations

import datetime
import os
import sys
import uuid
from decimal import Decimal

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import serialize  # noqa: E402
from serialize import JS_MAX_SAFE_INT, serialize_value  # noqa: E402


# ── the 2^53 money boundary (the reason this module exists) ────────────────────────────────────


def test_int_at_boundary_stays_number():
    assert serialize_value(JS_MAX_SAFE_INT) == 2**53
    assert isinstance(serialize_value(JS_MAX_SAFE_INT), int)
    assert serialize_value(-JS_MAX_SAFE_INT) == -(2**53)


def test_int_beyond_boundary_becomes_string():
    assert serialize_value(JS_MAX_SAFE_INT + 1) == str(2**53 + 1)
    assert serialize_value(-JS_MAX_SAFE_INT - 1) == str(-(2**53) - 1)
    # a realistic HUGEINT revenue sum — paise must survive byte-exact
    assert serialize_value(1746754034_00000000) == "174675403400000000"


def test_small_ints_are_numbers():
    assert serialize_value(0) == 0
    assert serialize_value(-1) == -1


# ── scalars ────────────────────────────────────────────────────────────────────────────────────


def test_none_bool_str():
    assert serialize_value(None) is None
    assert serialize_value(True) is True   # bool must NOT hit the int branch (would emit 1)
    assert serialize_value(False) is False
    assert serialize_value("x") == "x"


def test_float_and_nan_inf():
    assert serialize_value(1.5) == 1.5
    assert serialize_value(float("nan")) is None
    assert serialize_value(float("inf")) is None
    assert serialize_value(float("-inf")) is None


def test_decimal_is_string():
    assert serialize_value(Decimal("1.23")) == "1.23"
    assert serialize_value(Decimal("-0.05")) == "-0.05"


def test_uuid_and_bytes():
    u = uuid.UUID("9c9f1309-c10b-4f78-9d7e-b4f80779c06a")
    assert serialize_value(u) == "9c9f1309-c10b-4f78-9d7e-b4f80779c06a"
    assert serialize_value(b"\x01\x02") == "AQI="  # base64, Trino's varbinary rendering


# ── temporal rendering (Trino string shapes) ───────────────────────────────────────────────────


def test_date_renders_iso():
    assert serialize_value(datetime.date(2026, 7, 16)) == "2026-07-16"


def test_naive_timestamp_renders_six_fraction_digits_no_zone():
    v = datetime.datetime(2026, 7, 16, 10, 0, 0, 123456)
    assert serialize_value(v) == "2026-07-16 10:00:00.123456"
    assert serialize_value(datetime.datetime(2026, 7, 16, 10, 0, 0)) == "2026-07-16 10:00:00.000000"


def test_timestamptz_renders_utc_suffix_not_offset():
    v = datetime.datetime(2026, 7, 16, 10, 0, 0, 725000, tzinfo=datetime.timezone.utc)
    assert serialize_value(v) == "2026-07-16 10:00:00.725000 UTC"  # never '…+00:00'


def test_timestamptz_non_utc_is_normalized_to_utc():
    ist = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
    v = datetime.datetime(2026, 7, 16, 15, 30, 0, tzinfo=ist)
    assert serialize_value(v) == "2026-07-16 10:00:00.000000 UTC"


def test_time_and_interval():
    assert serialize_value(datetime.time(10, 0, 0)) == "10:00:00"
    assert serialize_value(datetime.timedelta(days=7)) == "7 days, 0:00:00"


# ── containers recurse (journey Sankey edges = LIST<STRUCT> with money inside) ─────────────────


def test_list_and_struct_recurse():
    edges = [{"step": 1, "from_channel": "meta", "revenue_minor": JS_MAX_SAFE_INT + 7}]
    out = serialize_value(edges)
    assert out == [{"step": 1, "from_channel": "meta", "revenue_minor": str(2**53 + 7)}]


def test_unmapped_type_fails_loud():
    class Weird:
        pass

    try:
        serialize_value(Weird())
        raise AssertionError("expected TypeError for an unmapped type")
    except TypeError as exc:
        assert "unmapped" in str(exc)


# ── against a REAL DuckDB cursor (in-memory — local, no stack) ─────────────────────────────────


def test_end_to_end_against_duckdb_cursor():
    import duckdb

    con = duckdb.connect()
    con.execute("SET TimeZone='UTC';")
    cur = con.execute(
        """
        SELECT 1::BIGINT AS b,
               9007199254740993::HUGEINT AS h,
               CAST('1.23' AS DECIMAL(10,2)) AS de,
               'nan'::DOUBLE AS na,
               DATE '2026-07-16' AS dt,
               TIMESTAMPTZ '2026-07-16 10:00:00.123456' AS tstz,
               [1, 2] AS arr,
               {'step': 1, 'amt': 9007199254740993} AS st
        """
    )
    cols = serialize.columns_of(cur.description)
    rows = serialize.serialize_rows(cur.fetchall())
    assert [c["name"] for c in cols] == ["b", "h", "de", "na", "dt", "tstz", "arr", "st"]
    (b, h, de, na, dt, tstz, arr, st) = rows[0]
    assert b == 1
    assert h == "9007199254740993"          # HUGEINT past 2^53 → string
    assert de == "1.23"                     # DECIMAL → string
    assert na is None                       # NaN → null
    assert dt == "2026-07-16"
    assert tstz == "2026-07-16 10:00:00.123456 UTC"
    assert arr == [1, 2]
    assert st == {"step": 1, "amt": "9007199254740993"}


if __name__ == "__main__":
    import pytest

    sys.exit(pytest.main([__file__, "-q"]))
