# Agent Tracing Langfuse 集成

`langfuse/` 为多个编码智能体（coding agent）提供公司级统一的追踪能力，所有遥测数据通过单一的本地 OpenTelemetry Collector 入口进行路由。

支持的智能体：

- Claude Code
- Codex
- OpenCode
- Pi
- Cline

## 记录内容

所有集成使用统一的 Langfuse 观测命名模型：

- 轮次追踪：`<agent>.turn`，例如 `codex.turn` 或 `claudecode.turn`
- 模型调用：`llm.call`，对应 Langfuse `GENERATION`
- 工具调用：`tool.<toolName>`，对应 Langfuse `SPAN`

每条追踪包含脱敏后的输入/输出以及元数据，如用户、工作目录、模型、会话 ID、追踪来源，以及智能体暴露的对话记录路径。

超长输入/输出值会按 `LANGFUSE_MAX_IO_CHARS` 截断。匹配常见密钥模式的字段在上传前会被脱敏处理。

## 架构

```text
智能体钩子/插件
  -> OTLP/HTTP localhost:4318/v1/traces
  -> OpenTelemetry Collector
  -> 按 resource.attributes["agent.name"] 过滤
  -> 路由至对应智能体的 Langfuse 项目导出器
  -> Langfuse /api/public/otel
```

所有智能体共用同一个本地 Collector 接收端口：

```text
127.0.0.1:4318
```

Collector 通过 `agent.name` 路由来保证项目隔离：

| 智能体 | `agent.name` | Langfuse 项目凭证 |
| --- | --- | --- |
| Claude Code | `claudecode` | `LANGFUSE_AUTH_HEADER_CLAUDECODE` |
| Codex | `codex` | `LANGFUSE_AUTH_HEADER_CODEX` |
| OpenCode | `opencode` | `LANGFUSE_AUTH_HEADER_OPENCODE` |
| Pi | `pi` | `LANGFUSE_AUTH_HEADER_PI` |
| Cline | `cline` | `LANGFUSE_AUTH_HEADER_CLINE` |

## 技术栈

- Node.js ESM 钩子脚本（适配 Claude Code、Codex、OpenCode、Cline）
- TypeScript Pi 扩展包
- 基于 HTTP 的 OpenTelemetry Protocol（`/v1/traces`）
- OpenTelemetry Collector `filter` 处理器实现按智能体路由
- Langfuse OTLP 接入端点（`/api/public/otel`）
- Shell profile 引导脚本，实现全用户插件自动安装
- Docker / Docker Compose 生产环境 Collector 部署

## 目录结构

```text
langfuse/
  README.md
  setup-langfuse.sh                    # 生产环境 profile，适用于 /etc/profile.d
  setup-langfuse-profile-local.sh      # 本地开发 profile
  .env.example                         # 生产环境 Collector 环境变量模板
  scripts/otel-utils.mjs               # 共享 OTLP 转换工具
  otel-collector/
    collector-single-port.docker.yaml  # 单端口 Collector 配置
    docker-compose.single-port.yaml    # 生产环境 Docker Compose 模板
    README.md
  claude-code-langfuse/                # Claude Code 插件包
  codex-langfuse/                      # Codex 插件包及通知包装器
  opencode-langfuse/                   # OpenCode 插件包
  pi-langfuse/                         # Pi 扩展包
  cline-langfuse-tracker.js            # Cline 插件入口
```

## 生产环境部署

生产部署使用一份配置文件和一个部署脚本：

```sh
cd /opt/agent-tracing/langfuse
cp .env.example .env
vim .env
sudo ./deploy.sh
```

`deploy.sh` 会完成端到端部署：

- 从 `.env` 读取 `LANGFUSE_PUBLIC_KEY_*` 和 `LANGFUSE_SECRET_KEY_*`
- 自动生成 Collector 专用的 Basic Auth header 到 `otel-collector/.env.generated`
- 校验 `collector-single-port.docker.yaml`
- 启动或重建 `agent-langfuse-otelcol` 容器
- 检查容器是否运行并暴露 `4318`
- 安装 `/etc/profile.d/agent-langfuse.sh`，让交互式 shell 用户自动安装/修复插件

### 1. 克隆或更新仓库

```sh
sudo mkdir -p /opt/agent-tracing
sudo chown "$USER":"$USER" /opt/agent-tracing
git clone https://github.com/TTHNN-ld/agent-tracing.git /opt/agent-tracing
```

已有 checkout 时：

```sh
cd /opt/agent-tracing
git pull --ff-only
```

### 2. 配置 `.env`

```sh
cd /opt/agent-tracing/langfuse
cp .env.example .env
vim .env
```

.env 配置 Langfuse 项目凭证：

```sh
LANGFUSE_PUBLIC_KEY_OPENCODE=pk-lf-...
LANGFUSE_SECRET_KEY_OPENCODE=sk-lf-...
LANGFUSE_PUBLIC_KEY_PI=pk-lf-...
LANGFUSE_SECRET_KEY_PI=sk-lf-...
LANGFUSE_PUBLIC_KEY_CLINE=pk-lf-...
LANGFUSE_SECRET_KEY_CLINE=sk-lf-...
LANGFUSE_PUBLIC_KEY_CLAUDECODE=pk-lf-...
LANGFUSE_SECRET_KEY_CLAUDECODE=sk-lf-...
LANGFUSE_PUBLIC_KEY_CODEX=pk-lf-...
LANGFUSE_SECRET_KEY_CODEX=sk-lf-...
```

.env 同时配置两个 URL：

```sh
# agent 插件在宿主机上访问 Langfuse 时使用
LANGFUSE_BASE_URL=http://localhost:3000

# Collector 容器访问 Langfuse 时使用
LANGFUSE_OTEL_EXPORTER_BASE_URL=http://host.docker.internal:3000
```

常见 Collector URL：

```sh
# Langfuse 在 Docker 宿主机上
LANGFUSE_OTEL_EXPORTER_BASE_URL=http://host.docker.internal:3000

# Langfuse 暴露在内网地址上
LANGFUSE_OTEL_EXPORTER_BASE_URL=http://10.0.0.10:3000

# Langfuse Cloud
LANGFUSE_OTEL_EXPORTER_BASE_URL=https://cloud.langfuse.com
```

### 3. 执行部署

```sh
cd /opt/agent-tracing/langfuse
sudo ./deploy.sh
```

本地测试可跳过 profile 安装：

```sh
LANGFUSE_INSTALL_PROFILE=0 ./deploy.sh
```

检查状态：

```sh
docker ps --filter name=agent-langfuse-otelcol
docker logs agent-langfuse-otelcol --tail 80
```

期望看到：

```text
0.0.0.0:4318->4318/tcp
```

### 4. 新开终端验证

新开一个 login shell，让 `/etc/profile.d/agent-langfuse.sh` 生效。

检查环境变量：

```sh
env | grep '^LANGFUSE_OTEL_ENDPOINT_'
```

执行一次 agent 请求后，查看 Collector 日志：

```sh
docker logs agent-langfuse-otelcol --since 5m | grep Traces
```

## 本地开发

加载本地 profile：

```sh
source /path/to/agent-tracing/langfuse/setup-langfuse-profile-local.sh
```

使用 Docker Desktop 启动单端口 Collector：

```sh
cd /path/to/agent-tracing/langfuse/otel-collector
docker compose -f docker-compose.single-port.yaml --env-file .env.generated up -d
```

macOS 本地测试时，Langfuse 在 `localhost:3000`，使用：

```sh
LANGFUSE_OTEL_EXPORTER_BASE_URL=http://host.docker.internal:3000
```

## 运维说明

- 钩子设计为"失败放行"（fail open）。即使 Collector 不可用，智能体也应继续正常运行。
- `LANGFUSE_OTEL_TIMEOUT_MS` 默认为 `200` 毫秒。
- `LANGFUSE_OTEL_FALLBACK_INGESTION` 默认为 `0`。生产环境请保持关闭，以避免智能体钩子直接进行同步上传。
- Claude Code 和 Codex 的官方钩子/通知载荷不直接暴露完整的模型/工具上下文，因此使用本地对话记录重建方式。
- 当命名或解析逻辑变更时，已有的 Langfuse 记录不会被回填。

## 验证命令

验证 Collector 配置：

```sh
docker run --rm \
  --env-file /opt/agent-tracing/langfuse/otel-collector/.env.generated \
  -v /opt/agent-tracing/langfuse/otel-collector/collector-single-port.docker.yaml:/etc/otelcol/config.yaml:ro \
  otel/opentelemetry-collector:latest \
  validate --config /etc/otelcol/config.yaml
```

检查 JavaScript 钩子语法：

```sh
node --check langfuse/claude-code-langfuse/scripts/langfuse-hook.mjs
node --check langfuse/codex-langfuse/scripts/codex-notify-wrapper.mjs
node --check langfuse/opencode-langfuse/index.js
node --check langfuse/cline-langfuse-tracker.js
```
