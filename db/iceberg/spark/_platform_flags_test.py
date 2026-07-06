# SPEC: 0.5
"""
_platform_flags_test.py — pure-python tests for the Spark-side flag reader twin.

Locks the Python twin to the TypeScript service (packages/platform-flags):
  - key shape `{brand_id}:flag:{flag}` byte-identical to tenant-context flagKey(),
  - only the literal b'true' enables (default OFF),
  - FAIL-CLOSED on unreachable Redis / bad input (never raises),
  - tenant isolation: brand A's key never matches brand B's.

Run: `python3 db/iceberg/spark/_platform_flags_test.py` (no pytest / redis needed).
"""
import io
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _platform_flags import (  # noqa: E402
    _encode_command,
    _parse_redis_url,
    _read_reply,
    flag_key,
    is_flag_enabled,
)

BRAND_A = "aaaa1111-0000-4000-8000-aaaaaaaaaaaa"
BRAND_B = "bbbb2222-0000-4000-8000-bbbbbbbbbbbb"


def test_key_shape_matches_ts_flagkey():
    # GOLDEN — must stay byte-identical to tenant-context flagKey() output.
    assert flag_key(BRAND_A, "stitch.v2") == BRAND_A + ":flag:stitch.v2"


def test_key_is_brand_first_and_tenant_isolated():
    a = flag_key(BRAND_A, "stitch.v2")
    b = flag_key(BRAND_B, "stitch.v2")
    assert a.startswith(BRAND_A + ":") and b.startswith(BRAND_B + ":")
    assert a != b  # brand A's flag key can never address brand B's flag


def test_key_rejects_bad_segments():
    for bad in (("", "stitch.v2"), (BRAND_A, ""), ("a:b", "f"), (BRAND_A, "x:y")):
        try:
            flag_key(*bad)
            raise AssertionError("expected ValueError for {0!r}".format(bad))
        except ValueError:
            pass


def test_fail_closed_on_unreachable_redis():
    # TCP port 1 (reserved) — connection refused / times out fast. MUST return False, not raise.
    assert is_flag_enabled(BRAND_A, "stitch.v2",
                           redis_url="redis://127.0.0.1:1", timeout_seconds=0.2) is False


def test_fail_closed_on_garbage_inputs():
    assert is_flag_enabled("", "stitch.v2", redis_url="redis://127.0.0.1:1", timeout_seconds=0.2) is False
    assert is_flag_enabled(BRAND_A, "", redis_url="redis://127.0.0.1:1", timeout_seconds=0.2) is False
    assert is_flag_enabled("a:b", "stitch.v2", redis_url="redis://127.0.0.1:1", timeout_seconds=0.2) is False
    assert is_flag_enabled(BRAND_A, "stitch.v2", redis_url="not-a-url::::", timeout_seconds=0.2) is False


def test_resp_encode_get():
    # RESP2 golden: GET key → *2\r\n$3\r\nGET\r\n$<len>\r\n<key>\r\n
    key = flag_key(BRAND_A, "stitch.v2")
    expected = ("*2\r\n$3\r\nGET\r\n$" + str(len(key)) + "\r\n" + key + "\r\n").encode()
    assert _encode_command(["GET", key]) == expected


def test_resp_read_replies():
    assert _read_reply(io.BytesIO(b"+OK\r\n")) == b"OK"
    assert _read_reply(io.BytesIO(b"$4\r\ntrue\r\n")) == b"true"
    assert _read_reply(io.BytesIO(b"$5\r\nfalse\r\n")) == b"false"
    assert _read_reply(io.BytesIO(b"$-1\r\n")) is None  # absent key = default OFF upstream
    assert _read_reply(io.BytesIO(b":1\r\n")) == 1
    try:
        _read_reply(io.BytesIO(b"-ERR nope\r\n"))
        raise AssertionError("expected error reply to raise")
    except ConnectionError:
        pass


def test_only_literal_true_enables():
    # is_flag_enabled compares the raw reply to b'true' — simulate via the parser.
    assert _read_reply(io.BytesIO(b"$4\r\ntrue\r\n")) == b"true"
    assert _read_reply(io.BytesIO(b"$1\r\n1\r\n")) != b"true"
    assert _read_reply(io.BytesIO(b"$4\r\nTRUE\r\n")) != b"true"


def test_parse_redis_url():
    assert _parse_redis_url("redis://localhost:6379") == ("localhost", 6379, None, 0)
    assert _parse_redis_url("redis://redis:6379/2") == ("redis", 6379, None, 2)
    assert _parse_redis_url("redis://:s3cret@redis:6380") == ("redis", 6380, "s3cret", 0)
    assert _parse_redis_url("redis://localhost") == ("localhost", 6379, None, 0)


def _main():
    failures = 0
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and callable(fn):
            try:
                fn()
                print("PASS  {0}".format(name))
            except Exception as exc:  # noqa: BLE001 — test harness
                failures += 1
                print("FAIL  {0}: {1}".format(name, exc))
    if failures:
        sys.exit(1)
    print("all _platform_flags tests passed")


if __name__ == "__main__":
    _main()
