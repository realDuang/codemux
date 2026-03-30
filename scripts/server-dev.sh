#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
REPO_DIR=$(cd -- "${SCRIPT_DIR}/.." && pwd)
STATE_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/codemux-server"
APP_LOG="$STATE_DIR/dev.log"
TUNNEL_LOG="$STATE_DIR/tunnel.log"
APP_PID_FILE="$STATE_DIR/dev.pid"
TUNNEL_PID_FILE="$STATE_DIR/tunnel.pid"
LOCAL_URL_FILE="$STATE_DIR/local-url"
TUNNEL_URL_FILE="$STATE_DIR/tunnel-url"
XVFB_SCREEN="${CODEMUX_XVFB_SCREEN:-1280x720x24}"
DEFAULT_TIMEOUT="${CODEMUX_SERVER_START_TIMEOUT:-90}"

export PATH="$HOME/.bun/bin:$HOME/.opencode/bin:$PATH"

usage() {
  cat <<'EOF'
Usage:
  ./scripts/server-dev.sh start [--foreground] [--replace] [--tunnel]
  ./scripts/server-dev.sh stop
  ./scripts/server-dev.sh status
  ./scripts/server-dev.sh logs [app|tunnel]

Examples:
  ./scripts/server-dev.sh start --foreground
  ./scripts/server-dev.sh start --replace --tunnel
  ./scripts/server-dev.sh status
EOF
}

info() {
  printf '[36m> %s[0m
' "$*"
}

success() {
  printf '[32m[ok][0m %s
' "$*"
}

warn() {
  printf '[33m[!][0m %s
' "$*"
}

fail() {
  printf '[31m[x][0m %s
' "$*" >&2
  exit 1
}

ensure_command() {
  command -v "$1" >/dev/null 2>&1 || fail "Missing required command: $1"
}

read_pid_file() {
  local file="$1"
  [ -f "$file" ] || return 1
  tr -d '[:space:]' < "$file"
}

is_pid_running() {
  local pid="${1:-}"
  [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null
}

is_process_group_running() {
  local pgid="${1:-}"
  [ -n "$pgid" ] && kill -0 -- "-$pgid" 2>/dev/null
}

cleanup_stale_pid_file() {
  local file="$1"
  local pid
  pid=$(read_pid_file "$file" 2>/dev/null || true)
  if [ -n "$pid" ] && ! is_process_group_running "$pid"; then
    rm -f "$file"
  fi
}

read_local_url() {
  if [ -f "$LOCAL_URL_FILE" ] && [ -s "$LOCAL_URL_FILE" ]; then
    cat "$LOCAL_URL_FILE"
    return 0
  fi
  [ -f "$APP_LOG" ] || return 1
  grep -Eo 'http://localhost:[0-9]+/?' "$APP_LOG" | tail -n 1 | sed 's#/$##'
}

read_tunnel_url() {
  if [ -f "$TUNNEL_URL_FILE" ] && [ -s "$TUNNEL_URL_FILE" ]; then
    cat "$TUNNEL_URL_FILE"
    return 0
  fi
  [ -f "$TUNNEL_LOG" ] || return 1
  grep -Eo 'https://[^[:space:]]+\.trycloudflare\.com' "$TUNNEL_LOG" | tail -n 1
}

query_tunnel_status() {
  local local_url="$1"
  [ -n "$local_url" ] || return 1
  curl -fsS "$local_url/api/tunnel/status"
}

read_json_field() {
  local json="$1"
  local field="$2"
  node -e 'const [json, field] = process.argv.slice(1); let data = {}; try { data = JSON.parse(json || "{}"); } catch (_) { data = {}; } let value = data[field]; if (value == null) { value = ""; } process.stdout.write(String(value));' "$json" "$field"
}

stop_tunnel_via_api() {
  local local_url="$1"
  [ -n "$local_url" ] || return 0
  curl -fsS -X POST "$local_url/api/tunnel/stop" >/dev/null 2>&1 || true
}
find_repo_processes() {
  ps -eo pid=,args= | awk -v repo="$REPO_DIR" '''
    index($0, repo) > 0 && ($0 ~ /electron-vite dev/ || $0 ~ /node_modules\/electron\/dist\/electron/ || $0 ~ /bun run dev/) {
      print $1
    }
  ''' | sort -u
}

kill_pid_list() {
  local pids=("$@")
  [ "${#pids[@]}" -gt 0 ] || return 0

  kill -TERM "${pids[@]}" 2>/dev/null || true
  sleep 2

  local survivors=()
  local pid
  for pid in "${pids[@]}"; do
    if is_pid_running "$pid"; then
      survivors+=("$pid")
    fi
  done

  if [ "${#survivors[@]}" -gt 0 ]; then
    kill -KILL "${survivors[@]}" 2>/dev/null || true
  fi
}

kill_process_group_from_file() {
  local file="$1"
  local pid
  pid=$(read_pid_file "$file" 2>/dev/null || true)
  [ -n "$pid" ] || return 0

  if is_process_group_running "$pid"; then
    kill -TERM -- "-$pid" 2>/dev/null || kill -TERM "$pid" 2>/dev/null || true
    sleep 2
    if is_process_group_running "$pid"; then
      kill -KILL -- "-$pid" 2>/dev/null || kill -KILL "$pid" 2>/dev/null || true
    fi
  fi

  rm -f "$file"
}

ensure_repo_ready() {
  ensure_command bun
  ensure_command dbus-run-session
  ensure_command xvfb-run
  [ -d "$REPO_DIR/node_modules" ] || fail "node_modules is missing. Run bun install or ./scripts/server-init.sh first."
}

ensure_clean_start() {
  local replace="$1"
  cleanup_stale_pid_file "$APP_PID_FILE"
  cleanup_stale_pid_file "$TUNNEL_PID_FILE"

  local existing_app_pid existing_tunnel_pid
  existing_app_pid=$(read_pid_file "$APP_PID_FILE" 2>/dev/null || true)
  existing_tunnel_pid=$(read_pid_file "$TUNNEL_PID_FILE" 2>/dev/null || true)

  local repo_pids
  repo_pids=$(find_repo_processes || true)

  if [ -n "$existing_app_pid" ] || [ -n "$existing_tunnel_pid" ] || [ -n "$repo_pids" ]; then
    if [ "$replace" -ne 1 ]; then
      fail "An existing CodeMux dev instance was detected. Re-run with --replace or stop it first."
    fi

    info "Stopping existing CodeMux dev processes..."
    kill_process_group_from_file "$TUNNEL_PID_FILE"
    kill_process_group_from_file "$APP_PID_FILE"

    if [ -n "$repo_pids" ]; then
      # shellcheck disable=SC2206
      local pid_array=( $repo_pids )
      kill_pid_list "${pid_array[@]}"
    fi
  fi
}

wait_for_local_url() {
  local pid="$1"
  local attempts=$(( DEFAULT_TIMEOUT / 2 ))
  local url=""

  while [ "$attempts" -gt 0 ]; do
    url=$(read_local_url 2>/dev/null || true)
    if [ -n "$url" ]; then
      printf '%s
' "$url" > "$LOCAL_URL_FILE"
      printf '%s
' "$url"
      return 0
    fi

    if ! is_process_group_running "$pid"; then
      return 1
    fi

    sleep 2
    attempts=$(( attempts - 1 ))
  done

  return 1
}

wait_for_tunnel_url() {
  local pid="$1"
  local attempts=$(( DEFAULT_TIMEOUT / 2 ))
  local url=""

  while [ "$attempts" -gt 0 ]; do
    url=$(read_tunnel_url 2>/dev/null || true)
    if [ -n "$url" ]; then
      printf '%s
' "$url" > "$TUNNEL_URL_FILE"
      printf '%s
' "$url"
      return 0
    fi

    if ! is_process_group_running "$pid"; then
      return 1
    fi

    sleep 2
    attempts=$(( attempts - 1 ))
  done

  return 1
}

print_auth_status() {
  local access_code pending_count

  if access_code=$(bun scripts/server-auth.ts access-code --plain 2>/dev/null); then
    printf '  Access code: %s
' "$access_code"
  fi

  if pending_count=$(bun scripts/server-auth.ts access-requests --count 2>/dev/null); then
    printf '  Pending requests: %s
' "$pending_count"
    if [ "$pending_count" -gt 0 ] 2>/dev/null; then
      printf '  Review pending requests: bun run server:access-requests
'
    fi
  fi
}

start_foreground() {
  info "Starting CodeMux headless dev in the foreground..."
  printf '  Open another SSH session when you need:
'
  printf '    bun run server:access-code
'
  printf '    bun run server:access-requests
'
  cd "$REPO_DIR"
  exec env CODEMUX_DISABLE_COPILOT_DBUS=1 CODEMUX_SERVER_MODE=1 \
    dbus-run-session -- xvfb-run --auto-servernum --server-args="-screen 0 $XVFB_SCREEN" bun run dev
}

start_background() {
  local with_tunnel="$1"

  mkdir -p "$STATE_DIR"
  rm -f "$LOCAL_URL_FILE" "$TUNNEL_URL_FILE"
  : > "$APP_LOG"

  setsid bash -lc "export PATH=\"$HOME/.bun/bin:$HOME/.opencode/bin:\$PATH\"; export CODEMUX_DISABLE_COPILOT_DBUS=1; export CODEMUX_SERVER_MODE=1; cd \"$REPO_DIR\"; exec dbus-run-session -- xvfb-run --auto-servernum --server-args='-screen 0 $XVFB_SCREEN' bun run dev" > "$APP_LOG" 2>&1 &
  local app_pid=$!
  printf '%s
' "$app_pid" > "$APP_PID_FILE"

  info "Started CodeMux headless dev (PID $app_pid); waiting for the renderer URL..."
  local local_url
  if ! local_url=$(wait_for_local_url "$app_pid"); then
    warn "CodeMux exited before the renderer URL was detected. Recent logs:"
    tail -n 40 "$APP_LOG" || true
    exit 1
  fi

  success "CodeMux dev is ready: $local_url"
  printf '  App log: %s
' "$APP_LOG"
  print_auth_status

  if [ "$with_tunnel" -eq 1 ]; then
    : > "$TUNNEL_LOG"
    setsid bash -lc "exec cloudflared tunnel --url '$local_url'" > "$TUNNEL_LOG" 2>&1 &
    local tunnel_pid=$!
    printf '%s
' "$tunnel_pid" > "$TUNNEL_PID_FILE"

    info "Starting Cloudflare quick tunnel..."
    local tunnel_url
    if tunnel_url=$(wait_for_tunnel_url "$tunnel_pid"); then
      success "Tunnel is ready: $tunnel_url"
    else
      warn "Tunnel started, but the quick-tunnel URL was not detected yet."
    fi
    printf '  Tunnel log: %s
' "$TUNNEL_LOG"
    printf '  Review access requests from this terminal: bun run server:access-requests
'
  fi
}

stop_all() {
  cleanup_stale_pid_file "$APP_PID_FILE"
  cleanup_stale_pid_file "$TUNNEL_PID_FILE"

  local local_url
  local_url=$(read_local_url 2>/dev/null || true)
  stop_tunnel_via_api "$local_url"

  local had_state=0
  if read_pid_file "$TUNNEL_PID_FILE" >/dev/null 2>&1; then
    had_state=1
  fi
  if read_pid_file "$APP_PID_FILE" >/dev/null 2>&1; then
    had_state=1
  fi

  kill_process_group_from_file "$TUNNEL_PID_FILE"
  kill_process_group_from_file "$APP_PID_FILE"

  rm -f "$LOCAL_URL_FILE" "$TUNNEL_URL_FILE"

  if [ "$had_state" -eq 1 ]; then
    success "Stopped managed CodeMux server processes."
  else
    warn "No managed CodeMux server processes were running."
  fi
}
show_status() {
  cleanup_stale_pid_file "$APP_PID_FILE"
  cleanup_stale_pid_file "$TUNNEL_PID_FILE"

  local app_pid tunnel_pid local_url tunnel_url tunnel_json api_tunnel_status api_tunnel_url api_tunnel_error
  app_pid=$(read_pid_file "$APP_PID_FILE" 2>/dev/null || true)
  tunnel_pid=$(read_pid_file "$TUNNEL_PID_FILE" 2>/dev/null || true)
  local_url=$(read_local_url 2>/dev/null || true)
  tunnel_url=$(read_tunnel_url 2>/dev/null || true)
  tunnel_json=""
  api_tunnel_status=""
  api_tunnel_url=""
  api_tunnel_error=""

  if [ -n "$local_url" ]; then
    tunnel_json=$(query_tunnel_status "$local_url" 2>/dev/null || true)
    if [ -n "$tunnel_json" ]; then
      api_tunnel_status=$(read_json_field "$tunnel_json" status 2>/dev/null || true)
      api_tunnel_url=$(read_json_field "$tunnel_json" url 2>/dev/null || true)
      api_tunnel_error=$(read_json_field "$tunnel_json" error 2>/dev/null || true)
      if [ -n "$api_tunnel_url" ]; then
        printf '%s\n' "$api_tunnel_url" > "$TUNNEL_URL_FILE"
        tunnel_url="$api_tunnel_url"
      fi
    fi
  fi

  if [ -n "$app_pid" ] && is_process_group_running "$app_pid"; then
    success "Headless dev server is running (PID $app_pid)."
    [ -n "$local_url" ] && printf '  Local URL: %s\n' "$local_url"
    printf '  App log: %s\n' "$APP_LOG"
    print_auth_status
  else
    warn "Headless dev server is not running."
  fi

  if [ "$api_tunnel_status" = "running" ] || [ "$api_tunnel_status" = "starting" ]; then
    success "Cloudflare tunnel is $api_tunnel_status."
    [ -n "$tunnel_url" ] && printf '  Tunnel URL: %s\n' "$tunnel_url"
    if [ -n "$tunnel_pid" ] && is_process_group_running "$tunnel_pid"; then
      printf '  Tunnel log: %s\n' "$TUNNEL_LOG"
    else
      printf '  Tunnel output: %s\n' "$APP_LOG"
    fi
  elif [ "$api_tunnel_status" = "error" ]; then
    warn "Cloudflare tunnel reported an error."
    [ -n "$api_tunnel_error" ] && printf '  Error: %s\n' "$api_tunnel_error"
    printf '  App log: %s\n' "$APP_LOG"
  elif [ -n "$tunnel_pid" ] && is_process_group_running "$tunnel_pid"; then
    success "Cloudflare tunnel is running (PID $tunnel_pid)."
    [ -n "$tunnel_url" ] && printf '  Tunnel URL: %s\n' "$tunnel_url"
    printf '  Tunnel log: %s\n' "$TUNNEL_LOG"
  else
    warn "Cloudflare tunnel is not running."
  fi
}
stream_logs() {
  local target="${1:-app}"
  local file

  case "$target" in
    app)
      file="$APP_LOG"
      ;;
    tunnel)
      file="$TUNNEL_LOG"
      ;;
    *)
      fail "Unknown log target: $target"
      ;;
  esac

  [ -f "$file" ] || fail "Log file not found: $file"
  exec tail -n 100 -f "$file"
}

main() {
  local command="${1:-help}"
  if [ "$#" -gt 0 ]; then
    shift
  fi

  case "$command" in
    start)
      local foreground=0
      local replace=0
      local with_tunnel=0

      while [ "$#" -gt 0 ]; do
        case "$1" in
          --foreground)
            foreground=1
            ;;
          --replace)
            replace=1
            ;;
          --tunnel)
            with_tunnel=1
            ;;
          -h|--help)
            usage
            exit 0
            ;;
          *)
            fail "Unknown option for start: $1"
            ;;
        esac
        shift
      done

      ensure_repo_ready
      if [ "$with_tunnel" -eq 1 ]; then
        ensure_command cloudflared
      fi
      ensure_clean_start "$replace"

      if [ "$foreground" -eq 1 ]; then
        if [ "$with_tunnel" -eq 1 ]; then
          fail "--tunnel is only supported for detached starts. Use bun run server:tunnel instead."
        fi
        start_foreground
      else
        start_background "$with_tunnel"
      fi
      ;;
    stop)
      [ "$#" -eq 0 ] || fail "stop does not accept extra arguments"
      stop_all
      ;;
    status)
      [ "$#" -eq 0 ] || fail "status does not accept extra arguments"
      show_status
      ;;
    logs)
      [ "$#" -le 1 ] || fail "logs accepts at most one argument: app or tunnel"
      stream_logs "${1:-app}"
      ;;
    help|-h|--help)
      usage
      ;;
    *)
      fail "Unknown command: $command"
      ;;
  esac
}

main "$@"
