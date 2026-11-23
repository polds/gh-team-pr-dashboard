{{- define "radar.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" }}
{{- end }}

{{- define "radar.fullname" -}}
{{- if .Values.fullnameOverride }}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- $name := include "radar.name" . }}
{{- if contains $name .Release.Name }}
{{- .Release.Name | trunc 63 | trimSuffix "-" }}
{{- else }}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" }}
{{- end }}
{{- end }}
{{- end }}

{{- define "radar.selectorLabels" -}}
app.kubernetes.io/name: {{ include "radar.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end }}

{{- define "radar.labels" -}}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" }}
{{ include "radar.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end }}

{{- define "radar.image" -}}
{{- printf "%s:%s" .Values.image.repository (default .Chart.AppVersion .Values.image.tag) }}
{{- end }}

{{/* The Secret that holds the GitHub App credentials: the user's own, or the one this chart creates. */}}
{{- define "radar.githubSecretName" -}}
{{- default (printf "%s-github" (include "radar.fullname" .)) .Values.existingSecret }}
{{- end }}

{{- define "radar.sessionSecretName" -}}
{{- printf "%s-session" (include "radar.fullname" .) }}
{{- end }}

{{/*
Fails the render with one message that names every missing setting. A half-configured release would
start a pod that exits at once, which is harder to read than this.
*/}}
{{- define "radar.validate" -}}
{{- if not .Values.demo }}
{{- $missing := list }}
{{- if not .Values.org }}{{ $missing = append $missing "org" }}{{ end }}
{{- if not .Values.host }}{{ $missing = append $missing "host" }}{{ end }}
{{- if not .Values.existingSecret }}
{{- range $key := list "appId" "clientId" "clientSecret" "privateKey" "webhookSecret" }}
{{- if not (index $.Values.github $key) }}{{ $missing = append $missing (printf "github.%s" $key) }}{{ end }}
{{- end }}
{{- end }}
{{- if $missing }}
{{- fail (printf "\n\npr-review-radar needs these values: %s.\nSet them, or set existingSecret to a Secret that holds the GitHub App credentials, or set demo=true to try the chart with a simulated organization." (join ", " $missing)) }}
{{- end }}
{{- end }}
{{- if and .Values.webhookIngress.enabled (not .Values.webhookIngress.host) }}
{{- fail "\n\nwebhookIngress.enabled is true, so webhookIngress.host is required." }}
{{- end }}
{{- if and .Values.gke.managedCertificate (not .Values.webhookIngress.enabled) }}
{{- fail "\n\ngke.managedCertificate issues a certificate for webhookIngress.host, so webhookIngress.enabled must be true." }}
{{- end }}
{{- end }}
