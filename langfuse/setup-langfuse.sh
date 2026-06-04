# Shared Langfuse setup for Pi / OpenCode / Cline / Claude Code / Codex.
#
# Intended usage:
#   source /path/to/plugin/langfuse/setup-langfuse.sh
#
# For all users, place or source this file from /etc/profile.d/agent-langfuse.sh.
# Plugin installation only runs for interactive shells and is guarded by
# per-user marker files plus a simple mkdir-based lock.

# ---------- Langfuse endpoint and credentials -------------------

export LANGFUSE_ENVIRONMENT=production

# OpenCode
export LANGFUSE_PUBLIC_KEY_OPENCODE=pk-lf-213c426e-6b8c-4f16-82c6-3432a2689bfd
export LANGFUSE_SECRET_KEY_OPENCODE=sk-lf-5af9fd40-907b-41a0-8c37-c1f6e3818999
export LANGFUSE_BASEURL_OPENCODE=http://localhost:3000

# Cline
export LANGFUSE_PUBLIC_KEY_CLINE=pk-lf-213c426e-6b8c-4f16-82c6-3432a2689bfd
export LANGFUSE_SECRET_KEY_CLINE=sk-lf-5af9fd40-907b-41a0-8c37-c1f6e3818999
export LANGFUSE_BASEURL_CLINE=http://localhost:3000

# Pi
export LANGFUSE_PUBLIC_KEY_PI=pk-lf-213c426e-6b8c-4f16-82c6-3432a2689bfd
export LANGFUSE_SECRET_KEY_PI=sk-lf-5af9fd40-907b-41a0-8c37-c1f6e3818999
export LANGFUSE_BASEURL_PI=http://localhost:3000

# Claude Code
export LANGFUSE_PUBLIC_KEY_CLAUDECODE=pk-lf-213c426e-6b8c-4f16-82c6-3432a2689bfd
export LANGFUSE_SECRET_KEY_CLAUDECODE=sk-lf-5af9fd40-907b-41a0-8c37-c1f6e3818999
export LANGFUSE_BASEURL_CLAUDECODE=http://localhost:3000

# Codex
export LANGFUSE_PUBLIC_KEY_CODEX=pk-lf-213c426e-6b8c-4f16-82c6-3432a2689bfd
export LANGFUSE_SECRET_KEY_CODEX=sk-lf-5af9fd40-907b-41a0-8c37-c1f6e3818999
export LANGFUSE_BASEURL_CODEX=http://localhost:3000

# ---------- Plugin source ---------------------------------------

: "${LANGFUSE_PLUGIN_SRC:=/NAS/Home/nt00342/code/plugin-langfuse}"

# ---------- Helpers ---------------------------------------------

_langfuse_has_command() {
    command -v "$1" >/dev/null 2>&1
}

_langfuse_run_once() {
    # Usage: _langfuse_run_once <name> <marker> <command...>
    _langfuse_name="$1"
    _langfuse_marker="$2"
    shift 2

    [ -f "$_langfuse_marker" ] && return 0

    _langfuse_marker_dir="$(dirname "$_langfuse_marker")"
    _langfuse_lock="${_langfuse_marker}.lock"
    mkdir -p "$_langfuse_marker_dir" || return 0

    if ! mkdir "$_langfuse_lock" 2>/dev/null; then
        return 0
    fi

    (
        trap 'rmdir "$_langfuse_lock" 2>/dev/null' EXIT

        [ -f "$_langfuse_marker" ] && exit 0

        echo "[langfuse] 首次安装 ${_langfuse_name} 插件..."
        if "$@"; then
            {
                echo "installed_at=$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
                echo "plugin_src=$LANGFUSE_PLUGIN_SRC"
            } >"$_langfuse_marker"
            echo "[langfuse] ${_langfuse_name} 插件安装成功"
        else
            _langfuse_code="$?"
            echo "[langfuse] ${_langfuse_name} 插件安装失败, 退出码: ${_langfuse_code}" >&2
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
        sh -c 'claude plugin marketplace add "$1" 2>/dev/null || true; claude plugin install claude-code-langfuse@agent-langfuse || claude plugin enable claude-code-langfuse' sh "$LANGFUSE_PLUGIN_SRC"
}

# ---------- Codex plugin ----------------------------------------

_install_codex_langfuse() {
    _langfuse_has_command codex || return 0
    [ -f "$LANGFUSE_PLUGIN_SRC/marketplace.json" ] || return 0
    [ -d "$LANGFUSE_PLUGIN_SRC/codex-langfuse" ] || return 0

    _langfuse_run_once \
        "Codex" \
        "$HOME/.codex/.langfuse_installed" \
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
unset -f _langfuse_run_once 2>/dev/null || true
unset LANGFUSE_PLUGIN_SRC
unset _langfuse_name _langfuse_marker _langfuse_marker_dir _langfuse_lock _langfuse_code
