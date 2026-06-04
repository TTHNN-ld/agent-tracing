# Pi / OpenCode / Cline / Claude Code / Codex 接入 Langfuse

本目录包含多个 agent 的 Langfuse 追踪集成：

```text
plugin/langfuse/
  README.md
  marketplace.json                 # Codex local marketplace
  .claude-plugin/marketplace.json  # Claude Code local marketplace
  pi-langfuse/                    # Pi package，可用 pi install 安装
  opencode-langfuse/              # OpenCode package，可用 opencode plugin 安装
  codex-langfuse/                  # Codex plugin package
  claude-code-langfuse/            # Claude Code plugin package
  pi-langfuse-tracker.ts           # Pi tracker 源文件
  opencode-langfuse-tracker.js     # OpenCode plugin
  cline-langfuse-tracker.js        # Cline plugin
```

## 通用配置

所有 tracker 都会记录：

- 每次 agent turn/run 的 Langfuse trace。
- 每次模型调用的 `llm.call` generation。
- 每次工具调用和结果的 `tool.*` span。
- 用户、环境、agent session 等 metadata。
- 脱敏后的输入/输出，大字段会按 `LANGFUSE_MAX_IO_CHARS` 截断。

通用可选变量：

```bash
export LANGFUSE_ENVIRONMENT=production
export LANGFUSE_USER_ID="$USER"
export LANGFUSE_USER_NAME="Your Name"
export LANGFUSE_TEAM="agent-team"
export LANGFUSE_MAX_IO_CHARS=20000
export LANGFUSE_FLUSH_INTERVAL_MS=1000
```

## Pi

Pi 使用 installable package。本目录下的 `pi-langfuse/` 已经打包成 Pi package。

### 安装

项目级安装，写入当前项目的 `.pi/settings.json`：

```bash
pi install -l /path/to/plugin/langfuse/pi-langfuse
```

用户全局安装，写入当前用户的 `~/.pi/agent/settings.json`：

```bash
pi install /path/to/plugin/langfuse/pi-langfuse
```

如果在本仓库源码里的 `pi/` 目录测试：

```bash
cd /Users/ld/work/ziguang/workCode/study/agent-cli/pi
./pi-test.sh install -l ../plugin/langfuse/pi-langfuse
```

### Langfuse 环境变量

```bash
export LANGFUSE_PUBLIC_KEY_PI=pk-lf-...
export LANGFUSE_SECRET_KEY_PI=sk-lf-...
export LANGFUSE_BASE_URL_PI=https://cloud.langfuse.com
```

Pi tracker 也会回退读取通用变量：

```bash
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
export LANGFUSE_BASE_URL=https://cloud.langfuse.com
```

然后启动：

```bash
pi
```

没有配置 key 时，Pi 扩展会自动禁用，不影响 Pi 正常使用。

## OpenCode

OpenCode 支持三种插件加载方式：

- 本地插件目录：`.opencode/plugins/` 或 `~/.config/opencode/plugins/`，支持 `.js` 和 `.ts` 文件。
- 配置文件：在 `opencode.json` 的 `plugin` 字段中声明 npm 包或本地路径。
- 安装命令：使用 `opencode plugin <module>` 将插件写入配置。

OpenCode 也提供安装命令：

```bash
opencode plugin <module>
```

别名：

```bash
opencode plug <module>
```

加 `-g` / `--global` 会安装到全局配置，加 `-f` / `--force` 会替换已有版本。

### 本地插件目录

项目级安装：

```bash
mkdir -p .opencode/plugins
cp /path/to/plugin/langfuse/opencode-langfuse-tracker.js .opencode/plugins/langfuse.js
```

用户全局安装：

```bash
mkdir -p ~/.config/opencode/plugins
cp /path/to/plugin/langfuse/opencode-langfuse-tracker.js ~/.config/opencode/plugins/langfuse.js
```

OpenCode 启动时会自动加载这些目录中的 `.js` 和 `.ts` 插件文件。

### 配置文件方式

也可以在 `opencode.json` 中声明本地插件路径：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["./.opencode/plugins/langfuse.js"]
}
```

路径会按声明它的配置文件位置解析。项目配置通常放在：

```text
opencode.json
```

用户全局配置通常放在：

```text
~/.config/opencode/opencode.json
```

### plugin 命令方式

`opencode plugin <module>` 用于安装包式插件并更新配置。适用场景包括 npm 包，以及带有 `package.json` 插件入口声明的本地或远程插件包。

本目录已经提供 package 形式：

```text
opencode-langfuse/
  package.json
  index.js
```

项目级安装：

```bash
opencode plugin /path/to/plugin/langfuse/opencode-langfuse
```

用户全局安装：

```bash
opencode plugin -g /path/to/plugin/langfuse/opencode-langfuse
```

替换已有配置：

```bash
opencode plugin -f /path/to/plugin/langfuse/opencode-langfuse
```

安装 npm 包时使用包名：

```bash
opencode plugin <module>
```

例如：

```bash
opencode plugin opencode-langfuse-tracker
```

全局安装：

```bash
opencode plugin -g opencode-langfuse-tracker
```

单个 `.js` / `.ts` 插件文件推荐使用“本地插件目录”或“配置文件方式”加载。

### Langfuse 环境变量

```bash
export LANGFUSE_PUBLIC_KEY_OPENCODE=pk-lf-...
export LANGFUSE_SECRET_KEY_OPENCODE=sk-lf-...
export LANGFUSE_BASE_URL_OPENCODE=https://cloud.langfuse.com
```

缺少 `LANGFUSE_PUBLIC_KEY_OPENCODE` 或 `LANGFUSE_SECRET_KEY_OPENCODE` 时，插件会打印 warning 并禁用追踪。

## Cline

Cline CLI 支持插件安装命令：

```bash
cline plugin install <source>
```

别名：

```bash
cline plugin i <source>
```

`<source>` 可以是 npm 包、git 仓库、远程插件文件 URL 或本地插件路径。常用参数：

```bash
cline plugin install <source> --force
cline plugin install <source> --cwd /path/to/project
cline plugin install <source> --npm
cline plugin install <source> --git
```

`--cwd <path>` 会安装到 `<path>/.cline/plugins`。不指定时使用当前上下文的默认 Cline 插件目录。

### 本地安装

安装本仓库里的 Cline tracker：

```bash
cline plugin install /path/to/plugin/langfuse/cline-langfuse-tracker.js
```

安装到指定项目：

```bash
cline plugin install /path/to/plugin/langfuse/cline-langfuse-tracker.js --cwd /path/to/project
```

如果要替换已安装版本：

```bash
cline plugin install /path/to/plugin/langfuse/cline-langfuse-tracker.js --force
```

Cline 也支持直接把插件文件放到 `.cline/plugins/` 或用户级插件目录，但推荐优先用 `cline plugin install`，方便 Cline 处理路径和依赖。

### Langfuse 环境变量

```bash
export LANGFUSE_PUBLIC_KEY_CLINE=pk-lf-...
export LANGFUSE_SECRET_KEY_CLINE=sk-lf-...
export LANGFUSE_BASE_URL_CLINE=https://cloud.langfuse.com
```

缺少 `LANGFUSE_PUBLIC_KEY_CLINE` 或 `LANGFUSE_SECRET_KEY_CLINE` 时，插件会禁用追踪。启用成功后会记录 `enabled` 日志。

### 配置后重启 Cline hub

Cline CLI 会复用已经启动的本地 hub runtime。环境变量只会在进程启动时继承一次，所以如果先启动过 Cline hub，再配置 Langfuse 环境变量，插件和聊天里的工具进程可能仍然读不到新的 `LANGFUSE_*_CLINE` 变量。

配置或更新 Langfuse 环境变量后，建议重启 Cline hub：

```bash
cline hub stop

cline hub start
```

## Claude Code

Claude Code 使用本目录的 local marketplace 安装：

```bash
claude plugin marketplace add /path/to/plugin/langfuse
claude plugin install claude-code-langfuse@agent-langfuse
```

### Langfuse 环境变量

```bash
export LANGFUSE_PUBLIC_KEY_CLAUDECODE=pk-lf-...
export LANGFUSE_SECRET_KEY_CLAUDECODE=sk-lf-...
export LANGFUSE_BASEURL_CLAUDECODE=https://cloud.langfuse.com
```

当前 Claude Code tracker 基于 hooks 记录 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop`、`StopFailure` 和 `SessionEnd`。它记录 turn trace 和 tool span；模型 request/usage 是否可用取决于 Claude Code hook payload。

## Codex

Codex 使用本目录的 local marketplace：

```bash
codex plugin marketplace add /path/to/plugin/langfuse
```

当前 Codex CLI 提供 marketplace 管理命令，但没有非交互式 `codex plugin install <name>` 子命令。如果 marketplace policy 没有自动启用插件，请在 Codex 中打开 `/plugins`，选择 `codex-langfuse` 安装或启用。

### Langfuse 环境变量

```bash
export LANGFUSE_PUBLIC_KEY_CODEX=pk-lf-...
export LANGFUSE_SECRET_KEY_CODEX=sk-lf-...
export LANGFUSE_BASEURL_CODEX=https://cloud.langfuse.com
```

当前 Codex tracker 基于 hooks 记录 `UserPromptSubmit`、`PreToolUse`、`PostToolUse`、`Stop` 和 `StopFailure`。它记录 turn trace 和 tool span；模型 request/usage 是否可用取决于 Codex hook payload。

## 统一安装脚本

`setup-langfuse.sh` 可以作为所有用户共享的登录初始化脚本使用。它会：

- 导出 Pi / OpenCode / Cline / Claude Code / Codex 的 Langfuse 环境变量。
- 只在交互式 shell 中执行插件安装。
- 为每个用户分别写入 marker，避免重复安装。
- 使用简单 lock，避免同一用户多个 shell 同时首次登录时并发安装。

默认插件源路径是：

```bash
/NAS/Home/nt00342/code/plugin-langfuse
```

如需覆盖：

```bash
export LANGFUSE_PLUGIN_SRC=/path/to/plugin/langfuse
source /path/to/plugin/langfuse/setup-langfuse.sh
```

全员共享时，可以在 `/etc/profile.d/agent-langfuse.sh` 中 source 它：

```bash
source /NAS/Home/nt00342/code/plugin-langfuse/setup-langfuse.sh
```

每个用户首次打开交互式 shell 时会自动安装：

```text
~/.pi/agent/.langfuse_installed
~/.config/opencode/.langfuse_installed
~/.cline/.langfuse_installed
~/.claude/.langfuse_installed
~/.codex/.langfuse_installed
```

如果插件源码更新，需要强制重装某个用户的插件，可以删除对应 marker 后重新登录，或手动执行对应安装命令。

## 服务器多用户建议

如果服务器上每个 Linux 用户都有自己的 agent 账号，建议各自维护自己的 agent 配置：

```text
~/.pi/agent/
~/.config/opencode/
~/.cline/
```

Langfuse 环境变量可以放到用户自己的 shell 配置：

```bash
~/.bashrc
~/.zshrc
```

如果要全员共享 Langfuse 变量，可以放到：

```bash
/etc/profile.d/agent-langfuse.sh
```

示例：

```bash
export LANGFUSE_ENVIRONMENT=production
export LANGFUSE_BASE_URL=https://cloud.langfuse.com
export LANGFUSE_PUBLIC_KEY=pk-lf-...
export LANGFUSE_SECRET_KEY=sk-lf-...
```

注意：共享 Langfuse key 通常没问题，但不要无意中共享 LLM 登录态、OAuth token 或 agent auth 文件。

Pi 如果设置了：

```bash
export PI_CODING_AGENT_DIR=/opt/pi-agent
```

就不会再读取当前用户的 `~/.pi/agent` 作为全局配置，而是改读 `/opt/pi-agent`。这适合共享插件配置，但不适合共享个人 LLM 登录凭据，除非你明确希望所有用户共用同一套账号。
