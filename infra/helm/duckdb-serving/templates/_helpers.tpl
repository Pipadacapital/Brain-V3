{{/*
Shared template helpers for the duckdb-serving chart. Resource names follow the Brain convention
brain-<environment>-duckdb-serving (e.g. brain-prod-duckdb-serving) so the BFF can target a stable
Service name — the same naming shape the retired trino chart used (brain-<env>-trino).
*/}}

{{- define "duckdb-serving.fullname" -}}
{{- printf "brain-%s-duckdb-serving" (required "environment is required (e.g. prod) — drives brain-<env>-duckdb-serving naming" .Values.environment) -}}
{{- end -}}

{{/* Common labels applied to every object. */}}
{{- define "duckdb-serving.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: brain
app.kubernetes.io/managed-by: {{ .Release.Service }}
brain.environment: {{ .Values.environment }}
{{- end -}}

{{/* Selector labels (Deployment/Service/HPA/PodMonitor all key on these). */}}
{{- define "duckdb-serving.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
