{{- define "neo4j-backup.labels" -}}
app.kubernetes.io/name: neo4j-backup
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
project: brain
service: neo4j-backup
{{- end -}}
