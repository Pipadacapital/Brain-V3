#!/usr/bin/env bash
###############################################################################
# Repoint stream-worker-env BRAIN_APP_DATABASE_URL from Aurora-DIRECT
# (…@AUR:5432/brain?sslmode=require) to pgbouncer (…@pgbouncer:6432/brain), to
# match collector-env / seed-core-env. seed-prod-secrets.sh:103 mistakenly used
# the direct URL; with pg-connection-string v3, sslmode=require is verify-full
# and fails against the Amazon RDS CA (not in Node's trust store) →
# "unable to get local issuer certificate" → stream-worker CrashLoopBackOff.
#
# The brain_app password is read from the existing secret and rewritten in
# place, server-side; it is never printed. Only the URL host/port changes.
###############################################################################
set -euo pipefail
REGION=ap-south-1
PGB="pgbouncer.pgbouncer.svc.cluster.local:6432"

CUR=$(aws secretsmanager get-secret-value --region "$REGION" \
        --secret-id brain/prod/k8s/stream-worker-env --query SecretString --output text)

NEW=$(CUR="$CUR" PGB="$PGB" python3 -c '
import json, os, re
d = json.loads(os.environ["CUR"])
u = d["BRAIN_APP_DATABASE_URL"]
creds = re.match(r"postgres://([^@]+)@", u).group(1)   # brain_app:<pw> — kept, never printed
d["BRAIN_APP_DATABASE_URL"] = "postgres://%s@%s/brain" % (creds, os.environ["PGB"])
print(json.dumps(d))
')

aws secretsmanager put-secret-value --region "$REGION" \
  --secret-id brain/prod/k8s/stream-worker-env --secret-string "$NEW" >/dev/null
echo "repointed stream-worker-env BRAIN_APP_DATABASE_URL -> pgbouncer (no client TLS)"
