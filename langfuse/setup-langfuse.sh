# Agent Langfuse setup for Pi / OpenCode / Cline / Claude Code / Codex.
#
# Production usage:
#   sudo cp /opt/agent-tracing/langfuse/setup-langfuse.sh /etc/profile.d/agent-langfuse.sh
#
# The profile is intentionally safe for all users:
# - it only installs plugins in interactive shells;
# - installs are guarded by per-user marker files and locks;
# - hooks send OTLP to the local Collector and fail open if unavailable.

# ---------- Plugin source and shared env ------------------------

: "${LANGFUSE_PLUGIN_SRC:=/opt/agent-tracing/langfuse}"
export LANGFUSE_PLUGIN_SRC

if [ -f "$LANGFUSE_PLUGIN_SRC/.env" ]; then
    set -a
    # shellcheck disable=SC1090
    . "$LANGFUSE_PLUGIN_SRC/.env"
    set +a
fi

# ---------- Langfuse endpoint and credentials -------------------

: "${LANGFUSE_ENVIRONMENT:=production}"
: "${LANGFUSE_BASE_URL:=http://localhost:3000}"
: "${LANGFUSE_MAX_IO_CHARS:=20000}"
: "${LANGFUSE_FLUSH_INTERVAL_MS:=1000}"
: "${LANGFUSE_TRANSPORT:=otel}"
: "${LANGFUSE_OTEL_TIMEOUT_MS:=200}"
: "${LANGFUSE_OTEL_FALLBACK_INGESTION:=0}"
: "${LANGFUSE_USER_ID:=$USER}"
: "${LANGFUSE_OTEL_ENDPOINT_CLAUDECODE:=http://127.0.0.1:4318}"
: "${LANGFUSE_OTEL_ENDPOINT_CODEX:=http://127.0.0.1:4318}"
: "${LANGFUSE_OTEL_ENDPOINT_OPENCODE:=http://127.0.0.1:4318}"
: "${LANGFUSE_OTEL_ENDPOINT_PI:=http://127.0.0.1:4318}"
: "${LANGFUSE_OTEL_ENDPOINT_CLINE:=http://127.0.0.1:4318}"

: "${LANGFUSE_PUBLIC_KEY_OPENCODE:=}"
: "${LANGFUSE_SECRET_KEY_OPENCODE:=}"
: "${LANGFUSE_BASEURL_OPENCODE:=${LANGFUSE_BASE_URL}}"

: "${LANGFUSE_PUBLIC_KEY_PI:=}"
: "${LANGFUSE_SECRET_KEY_PI:=}"
: "${LANGFUSE_BASEURL_PI:=${LANGFUSE_BASE_URL}}"

: "${LANGFUSE_PUBLIC_KEY_CLINE:=}"
: "${LANGFUSE_SECRET_KEY_CLINE:=}"
: "${LANGFUSE_BASEURL_CLINE:=${LANGFUSE_BASE_URL}}"

: "${LANGFUSE_PUBLIC_KEY_CLAUDECODE:=}"
: "${LANGFUSE_SECRET_KEY_CLAUDECODE:=}"
: "${LANGFUSE_BASEURL_CLAUDECODE:=${LANGFUSE_BASE_URL}}"

: "${LANGFUSE_PUBLIC_KEY_CODEX:=}"
: "${LANGFUSE_SECRET_KEY_CODEX:=}"
: "${LANGFUSE_BASEURL_CODEX:=${LANGFUSE_BASE_URL}}"

# Generic fallback for tools that read unscoped Langfuse variables.
: "${LANGFUSE_PUBLIC_KEY:=$LANGFUSE_PUBLIC_KEY_PI}"
: "${LANGFUSE_SECRET_KEY:=$LANGFUSE_SECRET_KEY_PI}"
: "${LANGFUSE_BASEURL:=$LANGFUSE_BASEURL_PI}"
: "${LANGFUSE_BASE_URL:=$LANGFUSE_BASEURL_PI}"

export LANGFUSE_ENVIRONMENT LANGFUSE_BASE_URL LANGFUSE_BASEURL
export LANGFUSE_MAX_IO_CHARS LANGFUSE_FLUSH_INTERVAL_MS
export LANGFUSE_TRANSPORT LANGFUSE_OTEL_TIMEOUT_MS LANGFUSE_OTEL_FALLBACK_INGESTION LANGFUSE_USER_ID
export LANGFUSE_OTEL_ENDPOINT_CLAUDECODE LANGFUSE_OTEL_ENDPOINT_CODEX
export LANGFUSE_OTEL_ENDPOINT_OPENCODE LANGFUSE_OTEL_ENDPOINT_PI LANGFUSE_OTEL_ENDPOINT_CLINE
export LANGFUSE_PUBLIC_KEY_OPENCODE LANGFUSE_SECRET_KEY_OPENCODE LANGFUSE_BASEURL_OPENCODE
export LANGFUSE_PUBLIC_KEY_PI LANGFUSE_SECRET_KEY_PI LANGFUSE_BASEURL_PI
export LANGFUSE_PUBLIC_KEY_CLINE LANGFUSE_SECRET_KEY_CLINE LANGFUSE_BASEURL_CLINE
export LANGFUSE_PUBLIC_KEY_CLAUDECODE LANGFUSE_SECRET_KEY_CLAUDECODE LANGFUSE_BASEURL_CLAUDECODE
export LANGFUSE_PUBLIC_KEY_CODEX LANGFUSE_SECRET_KEY_CODEX LANGFUSE_BASEURL_CODEX
export LANGFUSE_PUBLIC_KEY LANGFUSE_SECRET_KEY

# ---------- Helpers ---------------------------------------------

_langfuse_has_command() {
    command -v "$1" >/dev/null 2>&1
}

_langfuse_marker_is_current() {
    [ "${LANGFUSE_FORCE_REPAIR:-0}" = "1" ] && return 1
    [ -f "$1" ] && grep -q '^profile_version=8$' "$1" 2>/dev/null
}

_langfuse_write_marker() {
    mkdir -p "$(dirname "$1")" 2>/dev/null || return 0
    {
        echo "profile_version=8"
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

_install_claude_code_langfuse() {
    _langfuse_has_command claude || return 0
    [ -f "$LANGFUSE_PLUGIN_SRC/.claude-plugin/marketplace.json" ] || return 0
    [ -d "$LANGFUSE_PLUGIN_SRC/claude-code-langfuse" ] || return 0

    _langfuse_run_once \
        "Claude Code" \
        "$HOME/.claude/.langfuse_installed" \
        sh -c 'claude plugin marketplace add "$1" 2>/dev/null || true; claude plugin install -s user claude-code-langfuse@agent-langfuse >/dev/null 2>&1 || claude plugin enable -s user claude-code-langfuse >/dev/null 2>&1' sh "$LANGFUSE_PLUGIN_SRC"
}

# ---------- Codex plugin ----------------------------------------

_install_codex_langfuse() {
    _langfuse_has_command codex || return 0
    [ -f "$LANGFUSE_PLUGIN_SRC/marketplace.json" ] || return 0
    [ -d "$LANGFUSE_PLUGIN_SRC/codex-langfuse" ] || return 0

    _langfuse_run_once \
        "Codex" \
        "${CODEX_HOME:-$HOME/.codex}/.langfuse_installed" \
        sh -c 'codex plugin marketplace add "$1" 2>/dev/null || true' sh "$LANGFUSE_PLUGIN_SRC"
}

# ---------- Interactive shell bootstrap -------------------------

case $- in
    *i*)
        _install_pi_langfuse &
        _install_opencode_langfuse &
        _install_cline_langfuse &
        wait
        _install_claude_code_langfuse
        _install_codex_langfuse
        ;;
esac

unset -f _install_pi_langfuse 2>/dev/null || true
unset -f _install_opencode_langfuse 2>/dev/null || true
unset -f _install_cline_langfuse 2>/dev/null || true
unset -f _install_claude_code_langfuse 2>/dev/null || true
unset -f _install_codex_langfuse 2>/dev/null || true
unset -f _langfuse_has_command 2>/dev/null || true
unset -f _langfuse_marker_is_current 2>/dev/null || true
unset -f _langfuse_write_marker 2>/dev/null || true
unset -f _langfuse_run_once 2>/dev/null || true
unset _langfuse_name _langfuse_marker _langfuse_marker_dir _langfuse_lock _langfuse_code
