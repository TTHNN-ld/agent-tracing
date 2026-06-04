# Pi Langfuse Extension

Pi extension that records turns, model calls, and tool calls to Langfuse through the local OpenTelemetry Collector.

## Install

```sh
pi install /opt/agent-tracing/langfuse/pi-langfuse
```

The all-user profile `setup-langfuse.sh` installs this automatically for interactive shell users when `pi` is available.

## Runtime

The extension sends OTLP/HTTP traces to:

```sh
LANGFUSE_OTEL_ENDPOINT_PI=http://127.0.0.1:4318
```

The Collector routes by `agent.name=pi` to the Pi Langfuse project.
