#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."

export PORT="${PORT:-8080}"
export WAITRESS_MAX_REQUEST_BODY="${WAITRESS_MAX_REQUEST_BODY:-0}"

# Persist data by default when running locally
export DATA_DIR="${DATA_DIR:-$(pwd)/data}"

python -m app
