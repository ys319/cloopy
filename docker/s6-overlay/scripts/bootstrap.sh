#!/bin/bash
set -euo pipefail

# ==============================================================================
# bootstrap: User-Space Setup (Nix + Devbox)
# ==============================================================================
# Executed as the developer user via s6-setuidgid.
# Runs as a oneshot service, independent of sshd - SSH is available
# while this is still running.
# ==============================================================================

export DO_NOT_TRACK=1
export HOME="/home/developer"

# Retry wrapper for curl operations (3 attempts, exponential backoff)
curl_retry() {
    local max_attempts=3
    local wait=2
    for i in $(seq 1 "$max_attempts"); do
        if curl -fsSL "$@"; then
            return 0
        fi
        if [ "$i" -lt "$max_attempts" ]; then
            echo "[bootstrap] Attempt $i failed, retrying in ${wait}s..."
            sleep "$wait"
            wait=$((wait * 2))
        fi
    done
    echo "[bootstrap] ERROR: Failed after $max_attempts attempts"
    return 1
}

echo "[bootstrap] Starting user-space setup..."

# ------------------------------------------------------------------------------
# 1. Install Nix (Single-user, no daemon)
# ------------------------------------------------------------------------------
if [ -e "$HOME/.nix-profile/etc/profile.d/nix.sh" ]; then
    echo "[bootstrap] Nix found, sourcing profile"
    . "$HOME/.nix-profile/etc/profile.d/nix.sh"
elif ! command -v nix > /dev/null 2>&1; then
    echo "[bootstrap] Installing Nix (single-user)..."
    bash <(curl_retry https://nixos.org/nix/install) --no-daemon
    . "$HOME/.nix-profile/etc/profile.d/nix.sh"
else
    echo "[bootstrap] Nix already available"
fi

# ------------------------------------------------------------------------------
# 2. Install Devbox
# ------------------------------------------------------------------------------
if [ -f "$HOME/.local/bin/devbox" ]; then
    export PATH="$HOME/.local/bin:$PATH"
fi

if ! command -v devbox > /dev/null 2>&1; then
    echo "[bootstrap] Installing Devbox..."
    mkdir -p "$HOME/.local/bin"
    curl_retry "https://releases.jetify.com/devbox" -o "$HOME/.local/bin/devbox"
    chmod +x "$HOME/.local/bin/devbox"
fi

echo "[bootstrap] Complete"
