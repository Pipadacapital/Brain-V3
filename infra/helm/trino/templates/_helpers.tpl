{{/*
Shared template helpers for the trino chart. Resource names follow the Brain convention
brain-<environment>-trino (e.g. brain-prod-trino) so the BFF can target a stable Service name.
*/}}

{{- define "trino.fullname" -}}
{{- printf "brain-%s-trino" (required "environment is required (e.g. prod) — drives brain-<env>-trino naming + node.environment" .Values.environment) -}}
{{- end -}}

{{- define "trino.coordinator.fullname" -}}
{{- printf "%s-coordinator" (include "trino.fullname" .) -}}
{{- end -}}

{{- define "trino.worker.fullname" -}}
{{- printf "%s-worker" (include "trino.fullname" .) -}}
{{- end -}}

{{/*
BATCH cluster names (ADR-0002 — additive FTE cluster). brain-<env>-trino-batch is a SEPARATE logical
Trino cluster (own coordinator/discovery/Service) rendered only when batchCluster.enabled. Distinct
selector via app.kubernetes.io/component=batch-* keeps it from ever joining the interactive cluster.
*/}}
{{- define "trino.batch.fullname" -}}
{{- printf "%s-batch" (include "trino.fullname" .) -}}
{{- end -}}

{{- define "trino.batch.coordinator.fullname" -}}
{{- printf "%s-coordinator" (include "trino.batch.fullname" .) -}}
{{- end -}}

{{- define "trino.batch.worker.fullname" -}}
{{- printf "%s-worker" (include "trino.batch.fullname" .) -}}
{{- end -}}

{{/* Common labels applied to every object. */}}
{{- define "trino.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: brain
app.kubernetes.io/managed-by: {{ .Release.Service }}
brain.environment: {{ .Values.environment }}
{{- end -}}

{{/* Base selector (shared by coordinator + workers); callers add the component label. */}}
{{- define "trino.selectorLabels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
