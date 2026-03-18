#!/bin/bash
set -euo pipefail

# ==============================================================================
# init-permissions: UID/GID Adjustment & Volume Ownership
# ==============================================================================
# - Adjusts container user UID/GID to match PUID/PGID
# - Fixes ownership on persistent volumes (optimized with marker file)
# ==============================================================================

USER_NAME="developer"
USER_HOME="/home/${USER_NAME}"
PUID=${PUID:-1000}
PGID=${PGID:-1000}
MARKER="${USER_HOME}/.cloopy_owner"

echo "[init-permissions] Target UID/GID: ${PUID}:${PGID}"

# ------------------------------------------------------------------------------
# 1. Adjust UID/GID of the container user
# ------------------------------------------------------------------------------
CURRENT_UID=$(id -u "${USER_NAME}")
CURRENT_GID=$(id -g "${USER_NAME}")

if [[ "$PUID" != "$CURRENT_UID" || "$PGID" != "$CURRENT_GID" ]]; then
    echo "[init-permissions] Updating ${USER_NAME} from ${CURRENT_UID}:${CURRENT_GID} to ${PUID}:${PGID}"

    # Adjust GID
    if [[ "$PGID" != "$CURRENT_GID" ]]; then
        EXISTING_GROUP=$(getent group "$PGID" | cut -d: -f1 || true)
        if [[ -n "$EXISTING_GROUP" ]]; then
            echo "[init-permissions] GID ${PGID} exists as '${EXISTING_GROUP}', reusing"
            usermod -g "$EXISTING_GROUP" "${USER_NAME}"
        else
            groupmod -o -g "$PGID" "${USER_NAME}"
        fi
    fi

    # Adjust UID
    if [[ "$PUID" != "$CURRENT_UID" ]]; then
        usermod -o -u "$PUID" "${USER_NAME}"
    fi
fi

# ------------------------------------------------------------------------------
# 2. Fix volume ownership (optimized: skip if UID/GID unchanged)
# ------------------------------------------------------------------------------
CURRENT_OWNER="${PUID}:${PGID}"

needs_chown() {
    local target="$1"
    [[ ! -d "$target" ]] && return 1

    local dir_uid dir_gid
    dir_uid=$(stat -c '%u' "$target")
    dir_gid=$(stat -c '%g' "$target")

    [[ "$dir_uid" != "$PUID" || "$dir_gid" != "$PGID" ]]
}

if [[ -f "$MARKER" && "$(cat "$MARKER")" == "$CURRENT_OWNER" ]]; then
    echo "[init-permissions] UID/GID unchanged since last boot, skipping recursive chown"
    # Still fix top-level just in case
    for dir in "${USER_HOME}" /nix; do
        if [[ -d "$dir" ]] && needs_chown "$dir"; then
            chown "${PUID}:${PGID}" "$dir"
        fi
    done
else
    echo "[init-permissions] UID/GID changed or first boot, fixing ownership..."
    for dir in "${USER_HOME}" /nix; do
        if [[ -d "$dir" ]]; then
            echo "[init-permissions] chown -R ${PUID}:${PGID} ${dir} (this may take a while, timeout: 5min)"
            if ! timeout 300 chown -R "${PUID}:${PGID}" "$dir"; then
                echo "[init-permissions] WARN: chown timed out for ${dir}, fixing top-level only"
                chown "${PUID}:${PGID}" "$dir"
            fi
        fi
    done
    # Write marker (ensure home exists first)
    mkdir -p "${USER_HOME}"
    echo "$CURRENT_OWNER" > "$MARKER"
    chown "${PUID}:${PGID}" "$MARKER"
fi

# ------------------------------------------------------------------------------
# 3. Ensure essential directories exist
# ------------------------------------------------------------------------------
mkdir -p /run/sshd
mkdir -p "${USER_HOME}/.ssh"
chmod 700 "${USER_HOME}/.ssh"
chown "${PUID}:${PGID}" "${USER_HOME}/.ssh"

echo "[init-permissions] Done"
