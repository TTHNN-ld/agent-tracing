# OpenCode Langfuse Plugin

OpenCode plugin that records turns, model calls, and tool calls to Langfuse through the local OpenTelemetry Collector.

## Install

```sh
opencode plugin -g /opt/agent-tracing/langfuse/opencode-langfuse
```

The all-user profile `setup-langfuse.sh` installs this automatically for interactive shell users when `opencode` is available.

## Runtime

The plugin sends OTLP/HTTP traces to:

```sh
LANGFUSE_OTEL_ENDPOINT_OPENCODE=http://127.0.0.1:4318
```

The Collector routes by `agent.name=opencode` to the OpenCode Langfuse project.
