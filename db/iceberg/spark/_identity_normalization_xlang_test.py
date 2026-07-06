# SPEC: A.5.2
"""
_identity_normalization_xlang_test.py — cross-language hash-equivalence property test (WA-06).

Reads the JSONL corpus written by the TS generator
(packages/identity-normalization/src/a52-gen-corpus.ts — 12k+ mixed identifiers: unicode
emails, NFC/NFD variants, IN/GCC phone formats, garbage), re-derives normalized + interop +
internal (salted) from `raw` with the Python twin (_identity_normalization.py), and diffs
byte-for-byte against the TS-side values. A.5.2 requires 0 mismatches — hash drift silently
destroys stitch rates.

Run (single script, generates + diffs):
  packages/identity-normalization/scripts/run-a52-property-test.sh
or manually:
  pnpm --filter @brain/identity-normalization exec tsx src/a52-gen-corpus.ts /tmp/a52.jsonl
  python3 db/iceberg/spark/_identity_normalization_xlang_test.py /tmp/a52.jsonl

Requires: pip `phonenumbers` (pinned in db/iceberg/spark/Dockerfile).
Exit 0 iff row count >= 10000 AND MISMATCHES=0.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from _identity_normalization import (  # noqa: E402
    internal_hash,
    interop_hash,
    normalize_email,
    normalize_phone,
)

MIN_ROWS = 10000  # A.5.2: "10k+ generated identifiers"


def rederive(row):
    if row["kind"] == "email":
        normalized = normalize_email(row["raw"])
    else:
        normalized = normalize_phone(row["raw"], row["country"])
    return {
        "normalized": normalized,
        "interop": None if normalized is None else interop_hash(normalized),
        "internal": None if normalized is None else internal_hash(normalized, row["salt"]),
    }


def main(path):
    rows = 0
    mismatches = []
    hashed = 0
    nulls = 0
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip("\n")
            if not line:
                continue
            row = json.loads(line)
            rows += 1
            py = rederive(row)
            if py["normalized"] is None:
                nulls += 1
            else:
                hashed += 1
            for field in ("normalized", "interop", "internal"):
                if py[field] != row[field]:
                    mismatches.append(
                        {
                            "i": row["i"],
                            "kind": row["kind"],
                            "country": row["country"],
                            "raw": row["raw"],
                            "field": field,
                            "ts": row[field],
                            "py": py[field],
                        }
                    )

    for m in mismatches[:10]:
        print(f"MISMATCH {json.dumps(m, ensure_ascii=False)}")
    print(f"ROWS={rows} HASHED={hashed} NULL_IDENTIFIER={nulls} MISMATCHES={len(mismatches)}")
    if rows < MIN_ROWS:
        print(f"FAIL: corpus too small ({rows} < {MIN_ROWS})")
        return 1
    return 0 if len(mismatches) == 0 else 1


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
