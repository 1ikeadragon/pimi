#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DESKTOP_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
ROOT_DIR="$(cd "$DESKTOP_DIR/../.." && pwd)"

source "$ROOT_DIR/scripts/dev-home.sh"

export PATH="$ROOT_DIR/node_modules/.bin:$PATH"
export PIMI_LISTEN="${PIMI_LISTEN:-127.0.0.1:6768}"
configure_dev_pimi_home

DEV_ROOT="${PIMI_DEV_ROOT:-$(default_dev_paseo_root)}"
export PIMI_DEV_ROOT="$DEV_ROOT"
export PIMI_DEV_RUNTIME_FALLBACK_ROOT="$DEV_ROOT"
DEV_RUNTIME="$(node "$SCRIPT_DIR/dev-runtime.mjs")"
export PIMI_ELECTRON_FLAGS="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).electronFlags)' "$DEV_RUNTIME")"
export PIMI_ELECTRON_USER_DATA_DIR="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).userDataDir)' "$DEV_RUNTIME")"
unset PIMI_DEV_RUNTIME_FALLBACK_ROOT
mkdir -p "$PIMI_ELECTRON_USER_DATA_DIR"

if [ -z "${EXPO_PORT:-}" ]; then
  # First free port in 8082-8089.
  EXPO_PORT=$(node -e '
const net = require("node:net");
const ports = [8082, 8083, 8084, 8085, 8086, 8087, 8088, 8089];
(function tryPort(i) {
  if (i >= ports.length) { console.error("No free port in 8082-8089"); process.exit(1); }
  const server = net.createServer();
  server.once("error", () => tryPort(i + 1));
  server.listen(ports[i], () => server.close(() => process.stdout.write(String(ports[i]))));
})(0);
')
fi
export EXPO_PORT
export EXPO_DEV_URL="http://localhost:${EXPO_PORT}"

DAEMON_ENDPOINT="$(resolve_dev_daemon_endpoint)"
export PIMI_DAEMON_ENDPOINT="$DAEMON_ENDPOINT"

export PIMI_CORS_ORIGINS="${PIMI_CORS_ORIGINS:-*}"

npm --prefix "$DESKTOP_DIR" run build:main

echo "══════════════════════════════════════════════════════"
echo "  Pimi Desktop Dev"
echo "══════════════════════════════════════════════════════"
echo "  Metro:      ${EXPO_DEV_URL}"
echo "  Daemon:     ${PIMI_LISTEN}"
echo "  Home:       ${PIMI_HOME}"
echo "  userData:   ${PIMI_ELECTRON_USER_DATA_DIR}"
echo "══════════════════════════════════════════════════════"

exec node "$SCRIPT_DIR/dev-runner.mjs"
