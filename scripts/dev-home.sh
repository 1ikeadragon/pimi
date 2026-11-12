#!/usr/bin/env bash

default_dev_paseo_root() {
  git rev-parse --show-toplevel 2>/dev/null || pwd
}

copy_json_tree() {
  local source_dir="$1"
  local target_dir="$2"

  if [ ! -d "$source_dir" ]; then
    return
  fi

  mkdir -p "$target_dir"
  if command -v rsync >/dev/null 2>&1; then
    rsync -a --include='*/' --include='*.json' --exclude='*' "$source_dir/" "$target_dir/"
    return
  fi

  while IFS= read -r -d '' source_file; do
    local relative_path="${source_file#"$source_dir"/}"
    local target_file="$target_dir/$relative_path"
    mkdir -p "$(dirname "$target_file")"
    cp "$source_file" "$target_file"
  done < <(find "$source_dir" -type f -name '*.json' -print0)
}

has_files() {
  [ -d "$1" ] && [ -n "$(find "$1" -mindepth 1 -maxdepth 1 -print -quit 2>/dev/null)" ]
}

seed_worktree_pimi_home() {
  local source_home="${PIMI_DEV_SEED_HOME:-$HOME/.paseo}"
  local target_home="$1"

  if [ ! -d "$source_home" ]; then
    echo "  Seed:    skipped (${source_home} missing)"
    return
  fi

  if [ "$source_home" = "$target_home" ]; then
    echo "  Seed:    skipped (source is target)"
    return
  fi

  if [ "${PIMI_DEV_RESET_HOME:-0}" = "1" ]; then
    rm -rf "$target_home"
  elif has_files "$target_home"; then
    echo "  Seed:    skipped (${target_home} already has data)"
    return
  fi

  mkdir -p "$target_home"
  echo "  Seed:    copying metadata from ${source_home}"
  copy_json_tree "$source_home/agents" "$target_home/agents"
  copy_json_tree "$source_home/projects" "$target_home/projects"
  if [ -f "$source_home/config.json" ]; then
    cp "$source_home/config.json" "$target_home/config.json"
  fi

  echo "  Seed:    copied metadata from ${source_home}"
}

configure_dev_daemon_config() {
  if [ -z "${PIMI_LISTEN:-}" ]; then
    return
  fi

  mkdir -p "$PIMI_HOME"
  node -e '
const fs = require("fs");
const [path, listen] = [process.argv[1], process.argv[2]];
let cfg = {};
try { cfg = JSON.parse(fs.readFileSync(path, "utf8")); } catch {}
cfg.version = cfg.version || 1;
cfg.daemon = cfg.daemon || {};
cfg.daemon.listen = listen;
cfg.daemon.cors = cfg.daemon.cors || {};
cfg.daemon.cors.allowedOrigins = ["*"];
fs.writeFileSync(path, JSON.stringify(cfg, null, 2));
' "$PIMI_HOME/config.json" "$PIMI_LISTEN"
}

resolve_dev_daemon_endpoint() {
  if [ -n "${PIMI_DEV_DAEMON_ENDPOINT:-}" ]; then
    echo "$PIMI_DEV_DAEMON_ENDPOINT"
    return
  fi

  case "${PIMI_LISTEN:-127.0.0.1:6768}" in
    0.0.0.0:*) echo "localhost:${PIMI_LISTEN#0.0.0.0:}" ;;
    127.0.0.1:*) echo "localhost:${PIMI_LISTEN#127.0.0.1:}" ;;
    *) echo "$PIMI_LISTEN" ;;
  esac
}

# COMPAT(paseo-home): checkouts used .dev/paseo-home before the rename. Move it once and
# rewrite the absolute paths JSON files inside it store.
migrate_legacy_dev_home() {
  local dev_root="$1"
  local legacy="$dev_root/.dev/paseo-home"
  local target="$dev_root/.dev/pimi-home"
  if [ ! -d "$legacy" ] || [ -e "$target" ]; then
    return
  fi
  mv "$legacy" "$target"
  rm -f "$target/paseo.pid"
  find "$target" -maxdepth 4 -name '*.json' -not -path '*/node_modules/*' -exec \
    grep -l -F "$legacy" {} + 2>/dev/null | while IFS= read -r file; do
    LEGACY="$legacy" TARGET="$target" perl -0pi -e 's/\Q$ENV{LEGACY}\E/$ENV{TARGET}/g' "$file"
  done
  echo "Migrated dev home $legacy -> $target" >&2
}

configure_dev_pimi_home() {
  if [ -n "${PIMI_HOME:-}" ]; then
    export PIMI_HOME
    if [ -n "${PIMI_DEV_SEED_HOME:-}" ]; then
      seed_worktree_pimi_home "$PIMI_HOME"
    fi
    mkdir -p "$PIMI_HOME"
    if [ "${PIMI_DEV_MANAGED_HOME:-0}" = "1" ] || [ -n "${PIMI_DEV_SEED_HOME:-}" ]; then
      configure_dev_daemon_config
    fi
    return
  fi

  export PIMI_HOME
  local dev_root
  dev_root="${PIMI_DEV_ROOT:-$(default_dev_paseo_root)}"
  migrate_legacy_dev_home "$dev_root"
  PIMI_HOME="$dev_root/.dev/pimi-home"
  export PIMI_DEV_MANAGED_HOME=1

  if [ -n "${PIMI_DEV_SEED_HOME:-}" ]; then
    seed_worktree_pimi_home "$PIMI_HOME"
  fi

  mkdir -p "$PIMI_HOME"
  configure_dev_daemon_config
}

configure_dev_command_env() {
  if [ -z "${PIMI_LISTEN:-}" ]; then
    if [ -n "${PIMI_SERVICE_DAEMON_PORT:-}" ]; then
      export PIMI_LISTEN="0.0.0.0:${PIMI_SERVICE_DAEMON_PORT}"
    else
      export PIMI_LISTEN="127.0.0.1:6768"
    fi
  fi

  configure_dev_pimi_home
}

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  if [ "$#" -gt 0 ]; then
    configure_dev_command_env
    exec "$@"
  fi

  configure_dev_pimi_home
fi
