# Agent Langfuse OpenTelemetry Collector

Phase 1 routes Claude Code and Codex hooks through a local OpenTelemetry
Collector. Hooks send OTLP/HTTP to localhost and return quickly; the Collector
handles batching and forwarding to Langfuse.

## Ports

- Claude Code: `127.0.0.1:4318`
- Codex: `127.0.0.1:4319`

Both receivers expect OTLP/HTTP traces at `/v1/traces`.

## Required Environment

Source the profile first so the Collector can read credentials and endpoints:

```sh
source /path/to/plugin-langfuse/langfuse/setup-langfuse-profile-local.sh
```

The profile exports:

```sh
LANGFUSE_AUTH_HEADER_CLAUDECODE
LANGFUSE_AUTH_HEADER_CODEX
LANGFUSE_OTEL_EXPORTER_ENDPOINT_CLAUDECODE
LANGFUSE_OTEL_EXPORTER_ENDPOINT_CODEX
```

## Run With Docker

```sh
docker run --rm \
  --name agent-langfuse-otelcol \
  --network host \
  -e LANGFUSE_AUTH_HEADER_CLAUDECODE \
  -e LANGFUSE_AUTH_HEADER_CODEX \
  -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_CLAUDECODE \
  -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_CODEX \
  -v /path/to/plugin-langfuse/langfuse/otel-collector/collector-claude-codex.yaml:/etc/otelcol/config.yaml:ro \
  otel/opentelemetry-collector:latest \
  --config /etc/otelcol/config.yaml
```

On macOS Docker Desktop, `--network host` may not expose host networking the
same way it does on Linux. For local macOS testing, install `otelcol` via a
package manager or run the Collector directly on the host.

## Hook Defaults

The profile sets:

```sh
LANGFUSE_TRANSPORT=otel
LANGFUSE_OTEL_TIMEOUT_MS=200
LANGFUSE_OTEL_FALLBACK_INGESTION=0
```

If the Collector is unavailable, Claude Code/Codex hooks fail open and return
without direct Langfuse upload. Set `LANGFUSE_OTEL_FALLBACK_INGESTION=1` only
when you explicitly want a synchronous direct-ingestion fallback.
