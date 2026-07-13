#!/usr/bin/env bash
# tools/dr/s3-version-restore.sh — point-in-time restore of an S3 prefix from noncurrent versions.
#
# AUD-OPS-015: beyond the Iceberg snapshot window (7d marts / 14d
# collector lane) the ONLY recovery path for the medallion warehouse is the bucket's S3 versioning
# (90-day NoncurrentVersionExpiration lifecycle). This is the missing tooling: it rolls every object
# under a prefix back to its state AS OF a UTC timestamp, using only server-side operations:
#
#   - object existed at T with an older version   -> copy that versionId over itself (becomes latest)
#   - object did not exist at T but exists now    -> delete (adds a delete marker; reversible)
#   - object's latest version already matches T   -> no-op
#
# Nothing is ever permanently destroyed: restores are new versions / delete markers on a versioned
# bucket, so the restore itself is reversible (re-run with a later timestamp).
#
# ICEBERG WARNING: restoring an Iceberg table's data/ + metadata/ objects alone is NOT a consistent
# restore — the table pointer lives in the JDBC catalog on Aurora. Coordinate per
# docs/runbooks/DR.md §"Coordinated Aurora + S3 restore" (RB-1 Aurora PITR of iceberg_catalog to the
# SAME T, then this script over the table's S3 prefix). Never run this against a live table that
# writers (Kafka Connect / Spark) are still committing to — pause them first.
#
# DRY-RUN BY DEFAULT. Pass --execute to mutate. Requires: aws cli v2, jq.
#
# Usage:
#   tools/dr/s3-version-restore.sh \
#     --bucket brain-bronze-prod-380254378136 \
#     --prefix brain_bronze/collector_events_connect/ \
#     --timestamp 2026-07-10T02:00:00Z \
#     [--region ap-south-1] [--profile <aws-profile>] [--execute]
set -euo pipefail

BUCKET="" PREFIX="" TS="" REGION="${AWS_REGION:-ap-south-1}" PROFILE="" EXECUTE=0

usage() { grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 1; }

while [[ $# -gt 0 ]]; do
  case "$1" in
    --bucket)    BUCKET="$2"; shift 2 ;;
    --prefix)    PREFIX="$2"; shift 2 ;;
    --timestamp) TS="$2"; shift 2 ;;
    --region)    REGION="$2"; shift 2 ;;
    --profile)   PROFILE="$2"; shift 2 ;;
    --execute)   EXECUTE=1; shift ;;
    -h|--help)   usage ;;
    *) echo "unknown arg: $1" >&2; usage ;;
  esac
done

[[ -n "$BUCKET" && -n "$PREFIX" && -n "$TS" ]] || usage
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }
command -v aws >/dev/null || { echo "aws cli is required" >&2; exit 2; }

AWS=(aws --region "$REGION")
[[ -n "$PROFILE" ]] && AWS+=(--profile "$PROFILE")

# Normalize timestamp for lexicographic comparison against S3's ISO8601 LastModified.
# Accepts 2026-07-10T02:00:00Z or with offset; converts to UTC epoch for compare via jq's fromdate.
TS_EPOCH=$(jq -rn --arg t "$TS" '$t | sub("\\+00:00$"; "Z") | fromdate') \
  || { echo "could not parse --timestamp '$TS' (want e.g. 2026-07-10T02:00:00Z)" >&2; exit 2; }

echo "[s3-version-restore] bucket=s3://${BUCKET}/${PREFIX} as-of=${TS} (epoch ${TS_EPOCH}) mode=$([[ $EXECUTE -eq 1 ]] && echo EXECUTE || echo DRY-RUN)"

# One paginated listing of all versions + delete markers under the prefix. The aws cli paginates
# list-object-versions itself; jq merges the two arrays into per-key timelines.
LISTING=$("${AWS[@]}" s3api list-object-versions --bucket "$BUCKET" --prefix "$PREFIX" --output json)

# Emit one action per key: RESTORE <key> <versionId> | DELETE <key> | NOOP <key>
PLAN=$(jq -r --argjson ts "$TS_EPOCH" '
  ((.Versions // []) | map(. + {kind:"version"})) +
  ((.DeleteMarkers // []) | map(. + {kind:"marker"}))
  | map(. + {epoch: (.LastModified | sub("\\.[0-9]+"; "") | fromdate)})
  | group_by(.Key)
  | map(
      . as $entries
      | ($entries | map(select(.IsLatest == true)) | first) as $latest
      | ($entries | map(select(.epoch <= $ts)) | sort_by(.epoch) | last) as $asof
      | if $asof == null then
          # did not exist at T
          if $latest != null and $latest.kind == "version"
          then "DELETE\t\(.[0].Key)"
          else "NOOP\t\(.[0].Key)" end
        elif $asof.kind == "marker" then
          # deleted as of T
          if $latest != null and $latest.kind == "version"
          then "DELETE\t\(.[0].Key)"
          else "NOOP\t\(.[0].Key)" end
        else
          # existed at T as $asof
          if $latest != null and $latest.VersionId == $asof.VersionId
          then "NOOP\t\(.[0].Key)"
          else "RESTORE\t\(.[0].Key)\t\($asof.VersionId)" end
        end
    )
  | .[]
' <<<"$LISTING")

RESTORES=0 DELETES=0 NOOPS=0 FAILURES=0
while IFS=$'\t' read -r action key version; do
  [[ -z "${action:-}" ]] && continue
  case "$action" in
    NOOP) NOOPS=$((NOOPS + 1)) ;;
    RESTORE)
      RESTORES=$((RESTORES + 1))
      echo "RESTORE s3://${BUCKET}/${key} <- versionId=${version}"
      if [[ $EXECUTE -eq 1 ]]; then
        # Server-side copy of the as-of version onto the same key -> becomes the new latest.
        # No explicit SSE header: the bucket default (SSE-KMS) applies; the bucket policy only
        # denies EXPLICIT non-KMS headers (see modules/s3-iceberg bucket policy).
        "${AWS[@]}" s3api copy-object \
          --bucket "$BUCKET" --key "$key" \
          --copy-source "${BUCKET}/${key}?versionId=${version}" >/dev/null \
          || { echo "FAILED restore ${key}" >&2; FAILURES=$((FAILURES + 1)); }
      fi
      ;;
    DELETE)
      DELETES=$((DELETES + 1))
      echo "DELETE  s3://${BUCKET}/${key} (did not exist as of ${TS}; adds a delete marker)"
      if [[ $EXECUTE -eq 1 ]]; then
        "${AWS[@]}" s3api delete-object --bucket "$BUCKET" --key "$key" >/dev/null \
          || { echo "FAILED delete ${key}" >&2; FAILURES=$((FAILURES + 1)); }
      fi
      ;;
  esac
done <<<"$PLAN"

echo "[s3-version-restore] plan: restore=${RESTORES} delete=${DELETES} noop=${NOOPS} failures=${FAILURES} mode=$([[ $EXECUTE -eq 1 ]] && echo EXECUTE || echo DRY-RUN)"
[[ $EXECUTE -eq 0 && $((RESTORES + DELETES)) -gt 0 ]] && echo "[s3-version-restore] re-run with --execute to apply"
exit $((FAILURES > 0 ? 1 : 0))
