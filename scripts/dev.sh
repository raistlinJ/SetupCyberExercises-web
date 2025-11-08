#!/usr/bin/env bash
# Rebuild and restart the ToolHub container for rapid testing.
# Usage:
#   ./scripts/dev.sh               # rebuild and up
#   ./scripts/dev.sh -n            # no-cache rebuild
#   ./scripts/dev.sh -l            # show logs after up
#   ./scripts/dev.sh -d            # run detached (default)
#   ./scripts/dev.sh -f            # force recreate containers
#   ./scripts/dev.sh -r            # restart without rebuild
#   ./scripts/dev.sh -x            # remove all project containers (down)
set -euo pipefail

cd "$(dirname "$0")/.."

DETACH=true
NOCACHE=false
LOGS=false
FORCE_RECREATE=false
RESTART_ONLY=false
REMOVE_ALL=false

while getopts ":nldfrx" opt; do
  case $opt in
    n) NOCACHE=true ;;
    l) LOGS=true ;;
    d) DETACH=true ;;
    f) FORCE_RECREATE=true ;;
    r) RESTART_ONLY=true ;;
  x) REMOVE_ALL=true ;;
    *) echo "Unknown option: -$OPTARG" >&2; exit 2 ;;
  esac
done

if ! command -v docker >/dev/null 2>&1; then
  echo "Docker not found. Please install/start Docker Desktop." >&2
  exit 1
fi

COMPOSE_CMD=(docker compose)

if [ "$RESTART_ONLY" = true ]; then
  echo "Restarting containers..."
  "${COMPOSE_CMD[@]}" restart
  exit $?
fi

if [ "$REMOVE_ALL" = true ]; then
  echo "Removing all project containers (docker compose down --remove-orphans)..."
  set -x
  "${COMPOSE_CMD[@]}" down --remove-orphans || true
  set +x
fi

BUILD_ARGS=(--build)
[ "$NOCACHE" = true ] && BUILD_ARGS+=(--no-cache)

UP_ARGS=(-d)
[ "$DETACH" = false ] && UP_ARGS=()
[ "$FORCE_RECREATE" = true ] && UP_ARGS+=(--force-recreate)

set -x
"${COMPOSE_CMD[@]}" build ${NOCACHE:+--no-cache}
"${COMPOSE_CMD[@]}" up "${UP_ARGS[@]}" "${BUILD_ARGS[@]}"
set +x

if [ "$LOGS" = true ]; then
  echo
  echo "Tailing logs (Ctrl+C to stop)..."
  "${COMPOSE_CMD[@]}" logs -f --tail=100
fi
