#!/usr/bin/env sh
set -eu

LANGFUSE_DIR=${LANGFUSE_DIR:-$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)}
COLLECTOR_DIR="$LANGFUSE_DIR/otel-collector"
ENV_FILE=${LANGFUSE_ENV_FILE:-$LANGFUSE_DIR/.env}
GENERATED_ENV=${LANGFUSE_COLLECTOR_ENV:-$COLLECTOR_DIR/.env.generated}
COMPOSE_FILE=${LANGFUSE_COMPOSE_FILE:-$COLLECTOR_DIR/docker-compose.single-port.yaml}
COLLECTOR_CONFIG=${LANGFUSE_COLLECTOR_CONFIG:-$COLLECTOR_DIR/collector-single-port.docker.yaml}
PROFILE_TARGET=${LANGFUSE_PROFILE_TARGET:-/etc/profile.d/agent-langfuse.sh}
INSTALL_PROFILE=${LANGFUSE_INSTALL_PROFILE:-1}
CONTAINER_NAME=${LANGFUSE_COLLECTOR_CONTAINER:-agent-langfuse-otelcol}

log() {
    printf '[agent-langfuse] %s\n' "$*"
}

fail() {
    printf '[agent-langfuse] ERROR: %s\n' "$*" >&2
    exit 1
}

need_cmd() {
    command -v "$1" >/dev/null 2>&1 || fail "missing command: $1"
}

load_env() {
    [ -f "$ENV_FILE" ] || fail "missing env file: $ENV_FILE; copy .env.example to .env first"
    set -a
    # shellcheck disable=SC1090
    . "$ENV_FILE"
    set +a
}

require_var() {
    eval "value=\${$1:-}"
    [ -n "$value" ] || fail "missing required variable in $ENV_FILE: $1"
}

basic_header() {
    public_key=$1
    secret_key=$2
    printf 'Basic %s' "$(printf '%s:%s' "$public_key" "$secret_key" | base64 | tr -d '\n')"
}

write_generated_env() {
    mkdir -p "$COLLECTOR_DIR"
    base_url=${LANGFUSE_OTEL_EXPORTER_BASE_URL:-${LANGFUSE_BASE_URL:-http://host.docker.internal:3000}}
    endpoint="${base_url%/}/api/public/otel"

    cat >"$GENERATED_ENV" <<ENVEOF
LANGFUSE_COLLECTOR_AUTH_HEADER_OPENCODE='$(basic_header "$LANGFUSE_PUBLIC_KEY_OPENCODE" "$LANGFUSE_SECRET_KEY_OPENCODE")'
LANGFUSE_COLLECTOR_AUTH_HEADER_PI='$(basic_header "$LANGFUSE_PUBLIC_KEY_PI" "$LANGFUSE_SECRET_KEY_PI")'
LANGFUSE_COLLECTOR_AUTH_HEADER_CLINE='$(basic_header "$LANGFUSE_PUBLIC_KEY_CLINE" "$LANGFUSE_SECRET_KEY_CLINE")'
LANGFUSE_COLLECTOR_AUTH_HEADER_CLAUDECODE='$(basic_header "$LANGFUSE_PUBLIC_KEY_CLAUDECODE" "$LANGFUSE_SECRET_KEY_CLAUDECODE")'
LANGFUSE_COLLECTOR_AUTH_HEADER_CODEX='$(basic_header "$LANGFUSE_PUBLIC_KEY_CODEX" "$LANGFUSE_SECRET_KEY_CODEX")'
LANGFUSE_COLLECTOR_EXPORTER_ENDPOINT_OPENCODE=$endpoint
LANGFUSE_COLLECTOR_EXPORTER_ENDPOINT_PI=$endpoint
LANGFUSE_COLLECTOR_EXPORTER_ENDPOINT_CLINE=$endpoint
LANGFUSE_COLLECTOR_EXPORTER_ENDPOINT_CLAUDECODE=$endpoint
LANGFUSE_COLLECTOR_EXPORTER_ENDPOINT_CODEX=$endpoint
ENVEOF
    chmod 0600 "$GENERATED_ENV" 2>/dev/null || true
}

compose_cmd() {
    if docker compose version >/dev/null 2>&1; then
        docker compose "$@"
    elif command -v docker-compose >/dev/null 2>&1; then
        docker-compose "$@"
    else
        fail "missing docker compose"
    fi
}

validate_collector() {
    log "validating Collector config"
    docker run --rm \
        -e LANGFUSE_AUTH_HEADER_OPENCODE="$LANGFUSE_COLLECTOR_AUTH_HEADER_OPENCODE" \
        -e LANGFUSE_AUTH_HEADER_PI="$LANGFUSE_COLLECTOR_AUTH_HEADER_PI" \
        -e LANGFUSE_AUTH_HEADER_CLINE="$LANGFUSE_COLLECTOR_AUTH_HEADER_CLINE" \
        -e LANGFUSE_AUTH_HEADER_CLAUDECODE="$LANGFUSE_COLLECTOR_AUTH_HEADER_CLAUDECODE" \
        -e LANGFUSE_AUTH_HEADER_CODEX="$LANGFUSE_COLLECTOR_AUTH_HEADER_CODEX" \
        -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_OPENCODE="$LANGFUSE_COLLECTOR_EXPORTER_ENDPOINT_OPENCODE" \
        -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_PI="$LANGFUSE_COLLECTOR_EXPORTER_ENDPOINT_PI" \
        -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_CLINE="$LANGFUSE_COLLECTOR_EXPORTER_ENDPOINT_CLINE" \
        -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_CLAUDECODE="$LANGFUSE_COLLECTOR_EXPORTER_ENDPOINT_CLAUDECODE" \
        -e LANGFUSE_OTEL_EXPORTER_ENDPOINT_CODEX="$LANGFUSE_COLLECTOR_EXPORTER_ENDPOINT_CODEX" \
        -v "$COLLECTOR_CONFIG:/etc/otelcol/config.yaml:ro" \
        otel/opentelemetry-collector:latest \
        validate --config /etc/otelcol/config.yaml >/dev/null
}

start_collector() {
    if docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
        log "removing existing Collector container: $CONTAINER_NAME"
        docker rm -f "$CONTAINER_NAME" >/dev/null
    fi

    log "starting Collector container"
    compose_cmd -f "$COMPOSE_FILE" --env-file "$GENERATED_ENV" up -d
    docker ps --filter "name=$CONTAINER_NAME" --format '{{.Names}} {{.Status}} {{.Ports}}' | grep "$CONTAINER_NAME" >/dev/null \
        || fail "Collector container did not start"
    docker ps --filter "name=$CONTAINER_NAME" --format '{{.Names}} {{.Status}} {{.Ports}}'
}

install_profile() {
    [ "$INSTALL_PROFILE" = "1" ] || return 0
    [ -f "$LANGFUSE_DIR/setup-langfuse.sh" ] || fail "missing profile source: $LANGFUSE_DIR/setup-langfuse.sh"
    log "installing shell profile to $PROFILE_TARGET"
    tmp_file=$(mktemp)
    {
        printf 'export LANGFUSE_PLUGIN_SRC=%s\n' "$LANGFUSE_DIR"
        cat "$LANGFUSE_DIR/setup-langfuse.sh"
    } >"$tmp_file"
    if [ "$(id -u)" -eq 0 ]; then
        install -m 0644 "$tmp_file" "$PROFILE_TARGET"
    else
        sudo install -m 0644 "$tmp_file" "$PROFILE_TARGET"
    fi
    rm -f "$tmp_file"
}

main() {
    need_cmd docker
    need_cmd base64
    load_env

    for name in OPENCODE PI CLINE CLAUDECODE CODEX; do
        require_var "LANGFUSE_PUBLIC_KEY_$name"
        require_var "LANGFUSE_SECRET_KEY_$name"
    done

    write_generated_env
    set -a
    # shellcheck disable=SC1090
    . "$GENERATED_ENV"
    set +a
    validate_collector
    start_collector
    install_profile

    log "done"
    log "Collector endpoint: http://127.0.0.1:4318/v1/traces"
    log "Check logs: docker logs $CONTAINER_NAME --tail 80"
}

main "$@"
