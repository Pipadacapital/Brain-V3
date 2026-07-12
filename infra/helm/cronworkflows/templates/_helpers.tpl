{{/*
Shared template helpers — identical across all Brain service charts.
Resource names use the chart name (each service deploys to its own namespace).
*/}}
{{- define "brain.fullname" -}}
{{- .Chart.Name -}}
{{- end -}}

{{- define "brain.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: brain
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "brain.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- /*
Spark PG env derivation — shared by the v4-silver and v4-gold container scripts.
THREE env families exist across the Spark jobs (BRONZE_PG_* gate jobs,
SILVER_PG_* touchpoint/sessionization, GOLD_PG_* gold marts); all default to
the docker-compose host `postgres` and MUST be derived from core-env in prod.
KEEP the query string (sslmode=require — Aurora enforces SSL; pgJDBC understands it).
First prod fill 2026-07-11/12: missing derivation → UnknownHostException;
stripped query → "The connection attempt failed"; SILVER-only export → gate
jobs still on the compose default. This helper is the single fix point.
*/ -}}
{{- define "brain.sparkPgEnvDerivation" -}}
SRC_URL="${DATABASE_URL_DIRECT:-${DATABASE_URL:-}}"
if [ -n "$SRC_URL" ] && [ -z "${SILVER_PG_JDBC_URL:-}" ]; then
  stripped="${SRC_URL#postgres://}"; stripped="${stripped#postgresql://}"
  creds="${stripped%%@*}"; rest="${stripped#*@}"
  _pg_user="${creds%%:*}"; _pg_pass="${creds#*:}"
  hostport="${rest%%/*}"; db="${rest#*/}"
  for fam in BRONZE SILVER GOLD; do
    export ${fam}_PG_JDBC_URL="jdbc:postgresql://${hostport}/${db}"
    export ${fam}_PG_USER="${_pg_user}"
    export ${fam}_PG_PASSWORD="${_pg_pass}"
  done
  echo "[spark-pg-env] BRONZE/SILVER/GOLD PG JDBC derived (host ${hostport%%:*})"
fi
{{- end -}}
