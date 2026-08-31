{{- define "agentx.fullname" -}}
{{- .Release.Name }}-agentx
{{- end }}
{{- define "agentx.pgUrl" -}}
{{- if .Values.postgres.externalUrl }}{{ .Values.postgres.externalUrl }}{{- else -}}
postgres://postgres:{{ .Values.postgres.password }}@{{ include "agentx.fullname" . }}-postgres:5432/agentx
{{- end }}{{- end }}
{{- define "agentx.chUrl" -}}
{{- if .Values.clickhouse.externalUrl }}{{ .Values.clickhouse.externalUrl }}{{- else -}}
http://default:{{ .Values.clickhouse.password }}@{{ include "agentx.fullname" . }}-clickhouse:8123/default
{{- end }}{{- end }}
