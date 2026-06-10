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

    if ! command -v unzip > /dev/null 2>&1; then
        echo "[cloopy] ERROR: unzip is required to install Deno. Install unzip and retry."
        exit 1
    fi

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
    TMP_DIR="$(mktemp -d)"
    trap 'rm -f "$TMP_ZIP"; rm -rf "$TMP_DIR"' EXIT

    curl -fsSL --retry 3 --retry-delay 2 "$URL" -o "$TMP_ZIP"
    # Extract to a temp dir and move into place only when complete, so a
    # failed download/unzip never leaves a broken deno binary that later
    # runs would pick up and skip reinstalling.
    unzip -o -q "$TMP_ZIP" -d "$TMP_DIR"
    if [ ! -f "$TMP_DIR/deno" ]; then
        echo "[cloopy] ERROR: Deno installation failed (archive did not contain deno)"
        exit 1
    fi
    chmod +x "$TMP_DIR/deno"
    mkdir -p "$SCRIPT_DIR/.deno/bin"
    mv -f "$TMP_DIR/deno" "$DENO"

    if ! "$DENO" --version > /dev/null 2>&1; then
        echo "[cloopy] ERROR: Deno installation failed (binary does not run)"
        exit 1
    fi
fi

# --allow-all: the CLI drives docker/ssh-keygen and writes .env / ~/.ssh/config;
# Deno's permission prompts would add friction without real isolation here.
"$DENO" run --allow-all "$SCRIPT_DIR/cli/main.ts" "$@"
