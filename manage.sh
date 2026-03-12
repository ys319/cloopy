#!/bin/bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
if command -v deno > /dev/null 2>&1; then
    DENO="$(command -v deno)"
else
    DENO="$SCRIPT_DIR/.deno/bin/deno"
fi

if [ ! -f "$DENO" ]; then
    echo "[cloopy] Installing Deno locally..."

    # Detect platform
    OS="$(uname -s)"
    ARCH="$(uname -m)"
    case "$OS-$ARCH" in
        Darwin-arm64)  TARGET="deno-aarch64-apple-darwin.zip" ;;
        Darwin-x86_64) TARGET="deno-x86_64-apple-darwin.zip" ;;
        Linux-aarch64) TARGET="deno-aarch64-unknown-linux-gnu.zip" ;;
        Linux-x86_64)  TARGET="deno-x86_64-unknown-linux-gnu.zip" ;;
        *) echo "[cloopy] ERROR: Unsupported platform: $OS-$ARCH"; exit 1 ;;
    esac

    URL="https://github.com/denoland/deno/releases/latest/download/$TARGET"
    TMP_ZIP="$(mktemp)"
    trap 'rm -f "$TMP_ZIP"' EXIT

    curl -fsSL "$URL" -o "$TMP_ZIP"
    mkdir -p "$SCRIPT_DIR/.deno/bin"
    unzip -o -q "$TMP_ZIP" -d "$SCRIPT_DIR/.deno/bin"
    chmod +x "$DENO"

    if [ ! -f "$DENO" ]; then
        echo "[cloopy] ERROR: Deno installation failed"
        exit 1
    fi
fi

"$DENO" run --allow-all "$SCRIPT_DIR/cli/main.ts" "$@"
