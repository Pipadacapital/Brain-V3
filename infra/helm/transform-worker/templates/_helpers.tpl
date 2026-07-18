{{/*
Shared template helpers for the transform-worker chart. Resource names follow the Brain
brain-<environment>-transform-worker convention (e.g. brain-prod-transform-worker), the same
naming shape the sibling duckdb-serving chart uses — the transform-worker is a duckdb-family
workload (same brain-duckdb image, same brain-jobs IRSA, same Iceberg catalog secret).
*/}}

{{- define "transform-worker.fullname" -}}
{{- printf "brain-%s-transform-worker" (required "environment is required (e.g. prod) — drives brain-<env>-transform-worker naming" .Values.environment) -}}
{{- end -}}

{{/* Common labels applied to every object. */}}
{{- define "transform-worker.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: brain
app.kubernetes.io/managed-by: {{ .Release.Service }}
brain.environment: {{ .Values.environment }}
{{- end -}}

{{/* Selector labels (Deployment/PDB key on these). */}}
{{- define "transform-worker.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
