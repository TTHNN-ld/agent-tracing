# OpenCode Langfuse 插件

这是一个可用 `opencode plugin` 安装的 OpenCode package 插件。

## 安装

项目级安装：

```bash
opencode plugin /Users/ld/work/ziguang/workCode/study/agent-cli/plugin/langfuse/opencode-langfuse
```

用户全局安装：

```bash
opencode plugin -g /Users/ld/work/ziguang/workCode/study/agent-cli/plugin/langfuse/opencode-langfuse
```

替换已有配置：

```bash
opencode plugin -f /Users/ld/work/ziguang/workCode/study/agent-cli/plugin/langfuse/opencode-langfuse
```

## 配置

```bash
export LANGFUSE_PUBLIC_KEY_OPENCODE=pk-lf-...
export LANGFUSE_SECRET_KEY_OPENCODE=sk-lf-...
export LANGFUSE_BASE_URL_OPENCODE=https://cloud.langfuse.com
```

可选：

```bash
export LANGFUSE_ENVIRONMENT=production
export LANGFUSE_USER_ID="$USER"
export LANGFUSE_USER_NAME="Your Name"
export LANGFUSE_TEAM="agent-team"
export LANGFUSE_MAX_IO_CHARS=20000
export LANGFUSE_FLUSH_INTERVAL_MS=1000
```

缺少 `LANGFUSE_PUBLIC_KEY_OPENCODE` 或 `LANGFUSE_SECRET_KEY_OPENCODE` 时，插件会禁用追踪。
