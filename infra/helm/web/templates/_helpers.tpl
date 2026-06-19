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
