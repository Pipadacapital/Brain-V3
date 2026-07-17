{{/*
Shared template helpers for the strimzi-kafka chart. The Kafka cluster resource name follows the
Brain convention brain-<environment>-kafka (e.g. brain-prod-kafka). Strimzi derives the bootstrap
Service from this name, so the app's KAFKA_BROKERS bootstrap resolves to:

    brain-<env>-kafka-kafka-bootstrap.<namespace>.svc:9092   (plain, internal)
    brain-<env>-kafka-kafka-bootstrap.<namespace>.svc:9093   (tls,   internal)

That bootstrap wiring is a CONFIG change in the core chart's env (NOT made here) — see the ArgoCD
app + the deliverable notes.
*/}}

{{- define "strimziKafka.clusterName" -}}
{{- if .Values.clusterName -}}
{{- .Values.clusterName -}}
{{- else -}}
{{- printf "brain-%s-kafka" (required "environment is required (e.g. prod) — drives brain-<env>-kafka naming" .Values.environment) -}}
{{- end -}}
{{- end -}}

{{/* Sanitize a Kafka topic name (dots/underscores) into an RFC-1123 KafkaTopic metadata.name. */}}
{{- define "strimziKafka.topicResourceName" -}}
{{- . | lower | replace "." "-" | replace "_" "-" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{/*
Common labels applied to every Strimzi CR. Includes the Brain MANDATORY tags
(Environment / Service / Owner=data-team / CostCenter=brain-platform) as k8s labels so they
propagate onto the operator-managed StatefulSet/Pods/PVCs (and, via the gp3 StorageClass
tagSpecification, onto the EBS volumes — that StorageClass is an operator/platform concern,
documented in the deliverable notes).
*/}}
{{- define "strimziKafka.labels" -}}
app.kubernetes.io/name: {{ .Chart.Name }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/part-of: brain
app.kubernetes.io/managed-by: {{ .Release.Service }}
brain.environment: {{ .Values.environment }}
Environment: {{ .Values.environment }}
Service: kafka
Owner: data-team
CostCenter: brain-platform
{{- end -}}

{{/*
Resolve a topic's retention.ms from a symbolic tier ("short" | "standard" | "long") or an explicit override.
Usage: include "strimziKafka.retentionMs" (dict "tier" $t.retention "root" $)
*/}}
{{- define "strimziKafka.retentionMs" -}}
{{- $root := .root -}}
{{- if eq .tier "long" -}}
{{- $root.Values.topics.retention.longMs | int64 -}}
{{- else if eq .tier "short" -}}
{{- $root.Values.topics.retention.shortMs | int64 -}}
{{- else -}}
{{- $root.Values.topics.retention.standardMs | int64 -}}
{{- end -}}
{{- end -}}
