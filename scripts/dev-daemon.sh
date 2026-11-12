#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
export PATH="$SCRIPT_DIR/../node_modules/.bin:$PATH"

source "$SCRIPT_DIR/dev-home.sh"

export PIMI_LISTEN="${PIMI_LISTEN:-127.0.0.1:6768}"
configure_dev_pimi_home

if [ -z "${PIMI_LOCAL_MODELS_DIR}" ]; then
  export PIMI_LOCAL_MODELS_DIR="$HOME/.pimi/models/local-speech"
  mkdir -p "$PIMI_LOCAL_MODELS_DIR"
fi

echo "══════════════════════════════════════════════════════"
echo "  Pimi Dev Daemon"
echo "══════════════════════════════════════════════════════"
echo "  Home:    ${PIMI_HOME}"
echo "  Models:  ${PIMI_LOCAL_MODELS_DIR}"
echo "  Listen:  ${PIMI_LISTEN}"
echo "══════════════════════════════════════════════════════"

export PIMI_CORS_ORIGINS="${PIMI_CORS_ORIGINS:-*}"
export PIMI_NODE_INSPECT="${PIMI_NODE_INSPECT:---inspect=0}"

if [ "${PIMI_SKIP_DEV_SERVER_BUILD:-0}" = "1" ]; then
  exec npm run dev:server:watch
fi

exec sh -c 'npm run build:server-deps && npm run dev:server:watch'
