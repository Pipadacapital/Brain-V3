{{- define "iceberg-rest.name" -}}
brain-{{ .Values.environment | default "prod" }}-iceberg-rest
{{- end -}}

{{- define "iceberg-rest.labels" -}}
app.kubernetes.io/name: iceberg-rest
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
project: brain
service: iceberg-rest
{{- end -}}

{{- define "iceberg-rest.selectorLabels" -}}
app.kubernetes.io/name: iceberg-rest
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
