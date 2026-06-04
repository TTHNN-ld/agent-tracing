# Langfuse setup for Pi / OpenCode / Cline / Claude Code / Codex.
#
# Local test usage:
#   source /path/to/agent-tracing/langfuse/setup-langfuse-profile-local.sh
#
# Server usage:
#   cp this file /etc/profile.d/agent-langfuse.sh
#   export LANGFUSE_PLUGIN_SRC=/path/to/agent-tracing/langfuse before sourcing,
#   or edit the candidate paths below.

# ---------- Langfuse endpoint and credentials -------------------

if [ -n "${NODE_EXTRA_CA_CERTS:-}" ] && [ ! -f "$NODE_EXTRA_CA_CERTS" ]; then
    unset NODE_EXTRA_CA_CERTS
fi

: "${LANGFUSE_ENVIRONMENT:=production}"
: "${LANGFUSE_MAX_IO_CHARS:=20000}"
: "${LANGFUSE_FLUSH_INTERVAL_MS:=1000}"
: "${LANGFUSE_TRANSPORT:=otel}"
: "${LANGFUSE_OTEL_TIMEOUT_MS:=200}"
: "${LANGFUSE_OTEL_FALLBACK_INGESTION:=0}"
: "${LANGFUSE_OTEL_ENDPOINT_CLAUDECODE:=http://127.0.0.1:4318}"
: "${LANGFUSE_OTEL_ENDPOINT_CODEX:=http://127.0.0.1:4318}"
: "${LANGFUSE_OTEL_ENDPOINT_OPENCODE:=http://127.0.0.1:4318}"
: "${LANGFUSE_OTEL_ENDPOINT_PI:=http://127.0.0.1:4318}"
: "${LANGFUSE_OTEL_ENDPOINT_CLINE:=http://127.0.0.1:4318}"
export LANGFUSE_ENVIRONMENT LANGFUSE_MAX_IO_CHARS LANGFUSE_FLUSH_INTERVAL_MS
export LANGFUSE_TRANSPORT LANGFUSE_OTEL_TIMEOUT_MS LANGFUSE_OTEL_FALLBACK_INGESTION
export LANGFUSE_OTEL_ENDPOINT_CLAUDECODE LANGFUSE_OTEL_ENDPOINT_CODEX
export LANGFUSE_OTEL_ENDPOINT_OPENCODE LANGFUSE_OTEL_ENDPOINT_PI LANGFUSE_OTEL_ENDPOINT_CLINE

# OpenCode
: "${LANGFUSE_PUBLIC_KEY_OPENCODE:=}"
: "${LANGFUSE_SECRET_KEY_OPENCODE:=}"
: "${LANGFUSE_BASE_URL_OPENCODE:=http://localhost:3000}"
export LANGFUSE_PUBLIC_KEY_OPENCODE LANGFUSE_SECRET_KEY_OPENCODE LANGFUSE_BASE_URL_OPENCODE

# Pi
: "${LANGFUSE_PUBLIC_KEY_PI:=}"
: "${LANGFUSE_SECRET_KEY_PI:=}"
: "${LANGFUSE_BASE_URL_PI:=http://localhost:3000}"
export LANGFUSE_PUBLIC_KEY_PI LANGFUSE_SECRET_KEY_PI LANGFUSE_BASE_URL_PI

# Cline
: "${LANGFUSE_PUBLIC_KEY_CLINE:=}"
: "${LANGFUSE_SECRET_KEY_CLINE:=}"
: "${LANGFUSE_BASE_URL_CLINE:=http://localhost:3000}"
export LANGFUSE_PUBLIC_KEY_CLINE LANGFUSE_SECRET_KEY_CLINE LANGFUSE_BASE_URL_CLINE

# Claude Code
: "${LANGFUSE_PUBLIC_KEY_CLAUDECODE:=}"
: "${LANGFUSE_SECRET_KEY_CLAUDECODE:=}"
: "${LANGFUSE_BASE_URL_CLAUDECODE:=http://localhost:3000}"
export LANGFUSE_PUBLIC_KEY_CLAUDECODE LANGFUSE_SECRET_KEY_CLAUDECODE LANGFUSE_BASE_URL_CLAUDECODE

# Codex
: "${LANGFUSE_PUBLIC_KEY_CODEX:=}"
: "${LANGFUSE_SECRET_KEY_CODEX:=}"
: "${LANGFUSE_BASE_URL_CODEX:=http://localhost:3000}"
export LANGFUSE_PUBLIC_KEY_CODEX LANGFUSE_SECRET_KEY_CODEX LANGFUSE_BASE_URL_CODEX

# Generic fallback for tools that support the unscoped Langfuse variables.
: "${LANGFUSE_PUBLIC_KEY:=$LANGFUSE_PUBLIC_KEY_PI}"
: "${LANGFUSE_SECRET_KEY:=$LANGFUSE_SECRET_KEY_PI}"
: "${LANGFUSE_BASE_URL:=$LANGFUSE_BASE_URL_PI}"
export LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY LANGFUSE_BASE_URL

_langfuse_basic_auth() {
    if command -v base64 >/dev/null 2>&1; then
        printf 'Basic %s' "$(printf '%s:%s' "$1" "$2" | base64 | tr -d '\n')"
    fi
}

: "${LANGFUSE_AUTH_HEADER_CLAUDECODE:=$(_langfuse_basic_auth "$LANGFUSE_PUBLIC_KEY_CLAUDECODE" "$LANGFUSE_SECRET_KEY_CLAUDECODE")}"
: "${LANGFUSE_AUTH_HEADER_CODEX:=$(_langfuse_basic_auth "$LANGFUSE_PUBLIC_KEY_CODEX" "$LANGFUSE_SECRET_KEY_CODEX")}"
: "${LANGFUSE_AUTH_HEADER_OPENCODE:=$(_langfuse_basic_auth "$LANGFUSE_PUBLIC_KEY_OPENCODE" "$LANGFUSE_SECRET_KEY_OPENCODE")}"
: "${LANGFUSE_AUTH_HEADER_PI:=$(_langfuse_basic_auth "$LANGFUSE_PUBLIC_KEY_PI" "$LANGFUSE_SECRET_KEY_PI")}"
: "${LANGFUSE_AUTH_HEADER_CLINE:=$(_langfuse_basic_auth "$LANGFUSE_PUBLIC_KEY_CLINE" "$LANGFUSE_SECRET_KEY_CLINE")}"
: "${LANGFUSE_OTEL_EXPORTER_ENDPOINT_CLAUDECODE:=${LANGFUSE_BASE_URL_CLAUDECODE%/}/api/public/otel}"
: "${LANGFUSE_OTEL_EXPORTER_ENDPOINT_CODEX:=${LANGFUSE_BASE_URL_CODEX%/}/api/public/otel}"
: "${LANGFUSE_OTEL_EXPORTER_ENDPOINT_OPENCODE:=${LANGFUSE_BASE_URL_OPENCODE%/}/api/public/otel}"
: "${LANGFUSE_OTEL_EXPORTER_ENDPOINT_PI:=${LANGFUSE_BASE_URL_PI%/}/api/public/otel}"
: "${LANGFUSE_OTEL_EXPORTER_ENDPOINT_CLINE:=${LANGFUSE_BASE_URL_CLINE%/}/api/public/otel}"
: "${LANGFUSE_CODEX_NOTIFY_FORWARD:=[\"$HOME/.codex/computer-use/Codex Computer Use.app/Contents/SharedSupport/SkyComputerUseClient.app/Contents/MacOS/SkyComputerUseClient\",\"turn-ended\"]}"
export LANGFUSE_AUTH_HEADER_CLAUDECODE LANGFUSE_AUTH_HEADER_CODEX
export LANGFUSE_AUTH_HEADER_OPENCODE LANGFUSE_AUTH_HEADER_PI LANGFUSE_AUTH_HEADER_CLINE
export LANGFUSE_OTEL_EXPORTER_ENDPOINT_CLAUDECODE LANGFUSE_OTEL_EXPORTER_ENDPOINT_CODEX
export LANGFUSE_OTEL_EXPORTER_ENDPOINT_OPENCODE LANGFUSE_OTEL_EXPORTER_ENDPOINT_PI LANGFUSE_OTEL_EXPORTER_ENDPOINT_CLINE
export LANGFUSE_CODEX_NOTIFY_FORWARD

# ---------- Plugin source ---------------------------------------

if [ -z "${LANGFUSE_PLUGIN_SRC:-}" ]; then
    for _langfuse_candidate in \
        "/Users/ld/work/ziguang/workCode/opensource/agent-tracing/langfuse" \
        "/NAS/Home/nt00342/code/agent-tracing/langfuse" \
        "/NAS/Home/nt00342/code/agent-tracing/langfuse"
    do
        if [ -d "$_langfuse_candidate/codex-langfuse" ] && [ -d "$_langfuse_candidate/claude-code-langfuse" ]; then
            LANGFUSE_PLUGIN_SRC="$_langfuse_candidate"
            break
        fi
    done
fi

export LANGFUSE_PLUGIN_SRC

# ---------- Helpers ---------------------------------------------

_langfuse_has_command() {
    command -v "$1" >/dev/null 2>&1
}

_langfuse_marker_is_current() {
    [ "${LANGFUSE_FORCE_REPAIR:-0}" = "1" ] && return 1
    [ -f "$1" ] && grep -q '^profile_version=6$' "$1" 2>/dev/null
}

_langfuse_write_marker() {
    mkdir -p "$(dirname "$1")" 2>/dev/null || return 0
    {
        echo "profile_version=6"
        echo "installed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
        echo "plugin_src=$LANGFUSE_PLUGIN_SRC"
    } >"$1" 2>/dev/null || true
}

_langfuse_run_once() {
    _langfuse_name="$1"
    _langfuse_marker="$2"
    shift 2

    _langfuse_marker_is_current "$_langfuse_marker" && return 0
    _langfuse_marker_dir="$(dirname "$_langfuse_marker")"
    _langfuse_lock="${_langfuse_marker}.lock"
    mkdir -p "$_langfuse_marker_dir" 2>/dev/null || return 0

    if ! mkdir "$_langfuse_lock" 2>/dev/null; then
        return 0
    fi

    (
        trap 'rmdir "$_langfuse_lock" 2>/dev/null' EXIT
        _langfuse_marker_is_current "$_langfuse_marker" && exit 0

        if "$@" >/dev/null 2>&1; then
            _langfuse_write_marker "$_langfuse_marker"
        else
            _langfuse_code="$?"
            if [ "${LANGFUSE_VERBOSE:-0}" = "1" ]; then
                echo "[langfuse] ${_langfuse_name} plugin install/repair failed, exit code: ${_langfuse_code}" >&2
            fi
            exit "$_langfuse_code"
        fi
    )
}

# ---------- Pi plugin -------------------------------------------

_install_pi_langfuse() {
    _langfuse_has_command pi || return 0
    [ -d "$LANGFUSE_PLUGIN_SRC/pi-langfuse" ] || return 0

    _langfuse_run_once \
        "Pi" \
        "$HOME/.pi/agent/.langfuse_installed" \
        pi install "$LANGFUSE_PLUGIN_SRC/pi-langfuse"
}

# ---------- OpenCode plugin -------------------------------------

_install_opencode_langfuse() {
    _langfuse_has_command opencode || return 0
    [ -d "$LANGFUSE_PLUGIN_SRC/opencode-langfuse" ] || return 0

    _langfuse_run_once \
        "OpenCode" \
        "$HOME/.config/opencode/.langfuse_installed" \
        opencode plugin -g "$LANGFUSE_PLUGIN_SRC/opencode-langfuse"
}

# ---------- Cline plugin ----------------------------------------

_install_cline_langfuse() {
    _langfuse_has_command cline || return 0
    [ -f "$LANGFUSE_PLUGIN_SRC/cline-langfuse-tracker.js" ] || return 0

    _langfuse_run_once \
        "Cline" \
        "$HOME/.cline/.langfuse_installed" \
        cline plugin install "$LANGFUSE_PLUGIN_SRC/cline-langfuse-tracker.js"
}

# ---------- Claude Code plugin ----------------------------------

_repair_claude_code_langfuse() {
    claude plugin marketplace add "$LANGFUSE_PLUGIN_SRC" >/dev/null 2>&1 || true
    claude plugin install -s user claude-code-langfuse@agent-langfuse >/dev/null 2>&1 || true
    claude plugin update claude-code-langfuse >/dev/null 2>&1 || true
    claude plugin enable -s user claude-code-langfuse >/dev/null 2>&1 || true
    _langfuse_claude_status="$(claude plugin list 2>/dev/null)"
    printf '%s\n' "$_langfuse_claude_status" | grep -q 'claude-code-langfuse@agent-langfuse' || return 1
    printf '%s\n' "$_langfuse_claude_status" | grep -A 5 'claude-code-langfuse@agent-langfuse' | grep -q 'failed to load' && return 1
    return 0
}

_install_claude_code_langfuse() {
    _langfuse_has_command claude || return 0
    [ -f "$LANGFUSE_PLUGIN_SRC/.claude-plugin/marketplace.json" ] || return 0
    [ -d "$LANGFUSE_PLUGIN_SRC/claude-code-langfuse" ] || return 0

    _langfuse_run_once \
        "Claude Code" \
        "$HOME/.claude/.langfuse_installed" \
        _repair_claude_code_langfuse
}

# ---------- Codex plugin ----------------------------------------

_repair_codex_langfuse() {
    codex plugin marketplace add "$LANGFUSE_PLUGIN_SRC" >/dev/null 2>&1 || true
    _langfuse_codex_cache="${CODEX_HOME:-$HOME/.codex}/plugins/cache/agent-langfuse/codex-langfuse"
    _langfuse_codex_version="$(
        sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$LANGFUSE_PLUGIN_SRC/codex-langfuse/.codex-plugin/plugin.json" 2>/dev/null | head -n 1
    )"
    : "${_langfuse_codex_version:=0.0.0}"
    if [ -L "$_langfuse_codex_cache" ]; then
        rm "$_langfuse_codex_cache" 2>/dev/null || return 1
    fi
    if [ -d "$_langfuse_codex_cache" ]; then
        rm -rf "$_langfuse_codex_cache" 2>/dev/null || return 1
    fi
    mkdir -p "$_langfuse_codex_cache" 2>/dev/null || return 1
    cp -R "$LANGFUSE_PLUGIN_SRC/codex-langfuse" "$_langfuse_codex_cache/$_langfuse_codex_version" 2>/dev/null || return 1
    _langfuse_codex_config="${CODEX_HOME:-$HOME/.codex}/config.toml"
    mkdir -p "$(dirname "$_langfuse_codex_config")" 2>/dev/null || true
    touch "$_langfuse_codex_config" 2>/dev/null || return 1
    if ! grep -q '^\[features\]' "$_langfuse_codex_config" 2>/dev/null; then
        {
            printf '\n[features]\n'
            printf 'plugins = true\n'
        } >>"$_langfuse_codex_config" 2>/dev/null || return 1
    elif ! awk '
        /^\[features\]/ { in_block=1; next }
        /^\[/ { in_block=0 }
        in_block && /^plugins[[:space:]]*=[[:space:]]*true/ { found=1 }
        END { exit found ? 0 : 1 }
    ' "$_langfuse_codex_config" 2>/dev/null; then
        awk '
            /^\[features\]/ {
                print
                print "plugins = true"
                next
            }
            { print }
        ' "$_langfuse_codex_config" >"${_langfuse_codex_config}.tmp" 2>/dev/null &&
            mv "${_langfuse_codex_config}.tmp" "$_langfuse_codex_config" 2>/dev/null || return 1
    fi
    _langfuse_codex_node="$(command -v node 2>/dev/null || printf 'node')"
    _langfuse_codex_notify_line="notify = [\"$_langfuse_codex_node\", \"$LANGFUSE_PLUGIN_SRC/codex-langfuse/scripts/codex-notify-wrapper.mjs\"]"
    if grep -q '^notify[[:space:]]*=' "$_langfuse_codex_config" 2>/dev/null; then
        awk -v replacement="$_langfuse_codex_notify_line" '
            /^notify[[:space:]]*=/ { print replacement; next }
            { print }
        ' "$_langfuse_codex_config" >"${_langfuse_codex_config}.tmp" 2>/dev/null &&
            mv "${_langfuse_codex_config}.tmp" "$_langfuse_codex_config" 2>/dev/null || return 1
    else
        {
            printf '%s\n' "$_langfuse_codex_notify_line"
            cat "$_langfuse_codex_config"
        } >"${_langfuse_codex_config}.tmp" 2>/dev/null &&
            mv "${_langfuse_codex_config}.tmp" "$_langfuse_codex_config" 2>/dev/null || return 1
    fi
    if ! grep -q '^\[plugins\."codex-langfuse@agent-langfuse"\]' "$_langfuse_codex_config" 2>/dev/null; then
        {
            printf '\n[plugins."codex-langfuse@agent-langfuse"]\n'
            printf 'enabled = true\n'
        } >>"$_langfuse_codex_config" 2>/dev/null || return 1
    elif ! awk '
        /^\[plugins\."codex-langfuse@agent-langfuse"\]/ { in_block=1; next }
        /^\[/ { in_block=0 }
        in_block && /^enabled[[:space:]]*=[[:space:]]*true/ { found=1 }
        END { exit found ? 0 : 1 }
    ' "$_langfuse_codex_config" 2>/dev/null; then
        awk '
            /^\[plugins\."codex-langfuse@agent-langfuse"\]/ {
                print
                print "enabled = true"
                next
            }
            { print }
        ' "$_langfuse_codex_config" >"${_langfuse_codex_config}.tmp" 2>/dev/null &&
            mv "${_langfuse_codex_config}.tmp" "$_langfuse_codex_config" 2>/dev/null || return 1
    fi
    [ -f "$LANGFUSE_PLUGIN_SRC/marketplace.json" ] && [ -d "$LANGFUSE_PLUGIN_SRC/codex-langfuse" ]
}

_install_codex_langfuse() {
    _langfuse_has_command codex || return 0
    [ -f "$LANGFUSE_PLUGIN_SRC/marketplace.json" ] || return 0
    [ -d "$LANGFUSE_PLUGIN_SRC/codex-langfuse" ] || return 0

    _langfuse_run_once \
        "Codex" \
        "$HOME/.codex/.langfuse_installed" \
        _repair_codex_langfuse
}

# ---------- Interactive shell bootstrap -------------------------

case $- in
    *i*)
        if [ -n "${LANGFUSE_PLUGIN_SRC:-}" ]; then
            _install_pi_langfuse
            _install_opencode_langfuse
            _install_cline_langfuse
            _install_claude_code_langfuse
            _install_codex_langfuse
        else
            echo "[langfuse] LANGFUSE_PLUGIN_SRC is not set and plugin source was not found" >&2
        fi
        ;;
esac

unset -f _install_pi_langfuse 2>/dev/null || true
unset -f _install_opencode_langfuse 2>/dev/null || true
unset -f _install_cline_langfuse 2>/dev/null || true
unset -f _install_claude_code_langfuse 2>/dev/null || true
unset -f _install_codex_langfuse 2>/dev/null || true
unset -f _repair_claude_code_langfuse 2>/dev/null || true
unset -f _repair_codex_langfuse 2>/dev/null || true
unset -f _langfuse_has_command 2>/dev/null || true
unset -f _langfuse_marker_is_current 2>/dev/null || true
unset -f _langfuse_write_marker 2>/dev/null || true
unset -f _langfuse_run_once 2>/dev/null || true
unset -f _langfuse_basic_auth 2>/dev/null || true
unset _langfuse_candidate _langfuse_name _langfuse_marker _langfuse_marker_dir _langfuse_lock _langfuse_code _langfuse_claude_status _langfuse_codex_config _langfuse_codex_cache _langfuse_codex_version _langfuse_codex_node _langfuse_codex_notify_line
