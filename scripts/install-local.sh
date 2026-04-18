#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "${SCRIPT_DIR}/.." && pwd)"
INSTALL_DIR="${INSTALL_DIR:-$HOME/.local/bin}"
PLANNOTATOR_BIN="${INSTALL_DIR}/plannotator"
STACK_BIN="${INSTALL_DIR}/stack"

usage() {
    cat <<'USAGE'
Usage: scripts/install-local.sh [--install-dir <path>] [--help]

Builds this checkout and installs the local CLI to:
  - <install-dir>/plannotator
  - <install-dir>/stack

Defaults:
  install-dir: ~/.local/bin

Examples:
  ./scripts/install-local.sh
  ./scripts/install-local.sh --install-dir /usr/local/bin
USAGE
}

while [ $# -gt 0 ]; do
    case "$1" in
        --install-dir)
            if [ -z "${2:-}" ]; then
                echo "--install-dir requires a path" >&2
                usage >&2
                exit 1
            fi
            INSTALL_DIR="$2"
            PLANNOTATOR_BIN="${INSTALL_DIR}/plannotator"
            STACK_BIN="${INSTALL_DIR}/stack"
            shift 2
            ;;
        -h|--help)
            usage
            exit 0
            ;;
        *)
            echo "Unknown option: $1" >&2
            usage >&2
            exit 1
            ;;
    esac
done

if ! command -v bun >/dev/null 2>&1; then
    echo "bun is required but was not found in PATH" >&2
    exit 1
fi

mkdir -p "$INSTALL_DIR"

echo "Installing local Plannotator checkout from ${REPO_ROOT}"
echo "Install dir: ${INSTALL_DIR}"

cd "$REPO_ROOT"

bun install
bun run build:review
bun run build:hook
bun build apps/hook/server/index.ts --compile --outfile "$PLANNOTATOR_BIN"
ln -sf "$PLANNOTATOR_BIN" "$STACK_BIN"

echo ""
echo "Installed:"
echo "  ${PLANNOTATOR_BIN}"
echo "  ${STACK_BIN}"

case ":$PATH:" in
    *":${INSTALL_DIR}:"*)
        ;;
    *)
        echo ""
        echo "${INSTALL_DIR} is not on PATH."
        echo "Add it in your shell config, for example:"
        echo "  export PATH=\"${INSTALL_DIR}:\$PATH\""
        ;;
esac
