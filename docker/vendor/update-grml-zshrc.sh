#!/bin/bash
# Download the latest grml zshrc and vendor it into this directory.
# Run this script whenever you want to update the vendored copy.
set -euo pipefail
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
curl -fsSL https://git.grml.org/f/grml-etc-core/etc/zsh/zshrc \
  -o "$SCRIPT_DIR/grml-zshrc"
echo "Updated: $SCRIPT_DIR/grml-zshrc"
