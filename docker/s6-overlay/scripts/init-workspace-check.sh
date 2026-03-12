#!/bin/bash
set -euo pipefail

# ==============================================================================
# init-workspace-check: Bind Mount UID Mismatch Detection
# ==============================================================================
# Warns if the workspace bind mount is owned by a different UID than the
# container user. Does NOT chown (that would change host-side permissions).
# ==============================================================================

WORKSPACE="/home/developer/workspace"
PUID=${PUID:-1000}
PGID=${PGID:-1000}

if [[ ! -d "$WORKSPACE" ]]; then
    exit 0
fi

WS_UID=$(stat -c '%u' "$WORKSPACE")
WS_GID=$(stat -c '%g' "$WORKSPACE")

if [[ "$WS_UID" != "$PUID" || "$WS_GID" != "$PGID" ]]; then
    echo "============================================================"
    echo " WARNING: Workspace ownership mismatch"
    echo "============================================================"
    echo "  Workspace UID:GID = ${WS_UID}:${WS_GID}"
    echo "  Container UID:GID = ${PUID}:${PGID}"
    echo ""
    echo "  Files in /home/developer/workspace may not be writable."
    echo ""
    echo "  Fix: Set in .env:"
    echo "    CLOOPY_USER_UID=${WS_UID}"
    echo "    CLOOPY_USER_GID=${WS_GID}"
    echo "============================================================"
else
    echo "[init-workspace-check] Workspace ownership OK (${PUID}:${PGID})"
fi
