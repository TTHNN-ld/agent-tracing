# Agent Langfuse OpenTelemetry Collector

部署方式：所有智能体使用同一个本地 OTLP/HTTP 入口：

- 所有智能体将追踪数据发送至 `127.0.0.1:4318/v1/traces`。
- 每条载荷携带 `resource.attributes["agent.name"]`。
- Collector 按 `agent.name` 过滤，并转发至对应的 Langfuse 项目/导出器。

这样既保持了客户端配置的简洁性，又保留了按智能体的项目隔离。

## 智能体名称

- Claude Code：`claudecode`
- Codex：`codex`
- OpenCode：`opencode`
- Pi：`pi`
- Cline：`cline`

## 所需环境变量

生产环境通过 langfuse/.env 配置各 Langfuse 项目的 public/secret key，并执行部署脚本：

    cd /opt/agent-tracing/langfuse
    sudo ./deploy.sh

deploy.sh 生成 Collector 运行环境文件 otel-collector/.env.generated，Docker Compose 使用该文件启动容器。

## 调试运行单端口 Collector

在 Docker 内部，`localhost:3000` 指向 Collector 容器自身，而非宿主机的 Langfuse。导出器端点需使用 `host.docker.internal:3000`：

```sh
docker run -d \
  --name agent-langfuse-otelcol \
  -p 4318:4318 \
  -e LANGFUSE_AUTH_HEADER_CLAUDECODE \
  -e LANGFUSE_AUTH_HEADER_CODEX \
  -e LANGFUSE_AUTH_HEADER_OPENCODE \
  -e LANGFUSE_AUTH_HEADER_PI \
  -e LANGFUSE_AUTH_HEADER_CLINE \
  -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_CLAUDECODE=http://host.docker.internal:3000/api/public/otel \
  -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_CODEX=http://host.docker.internal:3000/api/public/otel \
  -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_OPENCODE=http://host.docker.internal:3000/api/public/otel \
  -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_PI=http://host.docker.internal:3000/api/public/otel \
  -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_CLINE=http://host.docker.internal:3000/api/public/otel \
  -v /path/to/agent-tracing/langfuse/otel-collector/collector-single-port.docker.yaml:/etc/otelcol/config.yaml:ro \
  otel/opentelemetry-collector:latest \
  --config /etc/otelcol/config.yaml
```

## Agent 钩子默认配置

Profile 将所有智能体的 OTLP 端点设为同一个本地 Collector 入口：

```sh
LANGFUSE_TRANSPORT=otel
LANGFUSE_OTEL_TIMEOUT_MS=200
LANGFUSE_OTEL_ENDPOINT_CLAUDECODE=http://127.0.0.1:4318
LANGFUSE_OTEL_ENDPOINT_CODEX=http://127.0.0.1:4318
LANGFUSE_OTEL_ENDPOINT_OPENCODE=http://127.0.0.1:4318
LANGFUSE_OTEL_ENDPOINT_PI=http://127.0.0.1:4318
LANGFUSE_OTEL_ENDPOINT_CLINE=http://127.0.0.1:4318
```

Collector 不可用时，钩子按失败放行策略返回，智能体主流程继续运行。`LANGFUSE_OTEL_FALLBACK_INGESTION=1` 用于启用同步直接接入兜底。
