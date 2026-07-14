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
DuckDB PG env derivation — shared by the v4-silver and v4-gold container scripts.
THREE env families exist across the transform jobs (BRONZE_PG_* gate/pixel-install,
SILVER_PG_* touchpoint/sessionization/identity, GOLD_PG_* cost marts); all default
to the docker-compose host `postgres`/`localhost` and MUST be derived from core-env
(DATABASE_URL_DIRECT) in prod. The canonical shell lives in files/derive-pg-env.sh
(the SINGLE fix point) and is unit-tested by files/derive-pg-env.test.sh — embedded
verbatim here so both cron scripts source identical, tested logic.
First prod fill 2026-07-11/12: missing derivation → UnknownHostException. Cutover
regression 2026-07-14: the include was dropped from the DuckDB scripts AND the
SILVER_PG_HOST/PORT/DB split form was never exported → pixel-lane R2 + cost marts
silently fail-soft to empty. Both fixed in the canonical file.
*/ -}}
{{- define "brain.sparkPgEnvDerivation" -}}
{{ .Files.Get "files/derive-pg-env.sh" }}
{{- end -}}
