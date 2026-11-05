#!/usr/bin/env bash
set -euo pipefail

# Build and run the Workers container with Apple's `container` (no Docker).
#
#   workers/scripts/container-dev.sh build
#   workers/scripts/container-dev.sh run
#   workers/scripts/container-dev.sh stop
#
# Requires macOS 26+ on Apple silicon, `container` installed and started
# (container system start). Install: https://github.com/apple/container/releases

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
IMAGE="${IMAGE:-opencode-slack-workers:dev}"
NAME="${NAME:-opencode-slack-workers}"
MODEL="${OPENCODE_MODEL:-opencode/deepseek-v4.1-flash}"
REPO="${WORKSPACE_REPO:-https://github.com/chester-hill-solutions/opencode-slack}"

if ! command -v container >/dev/null 2>&1; then
  echo "Apple container is not installed: https://github.com/apple/container/releases" >&2
  exit 1
fi

case "${1:-}" in
  build)
    container build -t "$IMAGE" "$ROOT"
    ;;
  run)
    container run --rm --name "$NAME" \
      -p 4000:4000 -p 4001:4001 \
      -e "OPENCODE_MODEL=$MODEL" \
      -e "WORKSPACE_REPO=$REPO" \
      "$IMAGE"
    ;;
  stop)
    container stop "$NAME"
    ;;
  *)
    echo "usage: $0 build|run|stop" >&2
    exit 1
    ;;
esac
