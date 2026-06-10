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
# IMPORTANT: we rewrite /etc/passwd directly instead of using `usermod -u`.
# `usermod -u` has a documented side effect — it recursively re-chowns the
# entire home directory tree — and because the image always boots as 1000:1000,
# that traversal would run on EVERY boot (minutes on a large /home, e.g. a
# populated Nix profile), blocking init-ssh-keys → svc-sshd and making SSH
# unavailable for the duration. File ownership is handled separately below via
# the marker-optimized `chown -R`, so usermod's traversal is pure waste.
CURRENT_UID=$(id -u "${USER_NAME}")
CURRENT_GID=$(id -g "${USER_NAME}")

if [[ "$PUID" != "$CURRENT_UID" || "$PGID" != "$CURRENT_GID" ]]; then
    echo "[init-permissions] Updating ${USER_NAME} from ${CURRENT_UID}:${CURRENT_GID} to ${PUID}:${PGID}"

    # If PGID has no group yet, repoint the 'developer' group to it. groupmod
    # does NOT traverse the filesystem (man: "you may have to change the GID of
    # files ... by hand"), so it is fast. If a group already owns PGID, the
    # passwd edit below just references it by number.
    if [[ "$PGID" != "$CURRENT_GID" ]]; then
        EXISTING_GROUP=$(getent group "$PGID" | cut -d: -f1 || true)
        if [[ -n "$EXISTING_GROUP" ]]; then
            echo "[init-permissions] GID ${PGID} exists as '${EXISTING_GROUP}', reusing"
        else
            groupmod -o -g "$PGID" "${USER_NAME}"
        fi
    fi

    # Fast UID/GID change: rewrite the uid:gid fields of the developer line.
    # Fall back to usermod only if the line is not in the expected format.
    if grep -qE "^${USER_NAME}:[^:]*:[0-9]+:[0-9]+:" /etc/passwd; then
        sed -i -E "s|^(${USER_NAME}:[^:]*:)[0-9]+:[0-9]+:|\1${PUID}:${PGID}:|" /etc/passwd
    else
        echo "[init-permissions] WARN: unexpected /etc/passwd line, falling back to usermod (slow)"
        # -g included: the sed path rewrites both fields, so the fallback must
        # too (the group exists — ensured by the groupmod branch above).
        usermod -o -u "$PUID" -g "$PGID" "${USER_NAME}"
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

# ------------------------------------------------------------------------------
# Host bind mounts under a directory (workspace, .zshenv, .claude/CLAUDE.md and
# any docker-compose.local.yml binds). The recursive chown must never descend
# into them: it would rewrite the ownership of the real files on the HOST —
# the same failure mode the authorized_keys staging copy exists to avoid (on
# rootless engines the files end up owned by a subuid and become unreadable on
# the host). Named volumes (mountinfo root looks like .../volumes/<name>/_data
# for both docker and podman) stay INCLUDED: their content is container-owned
# and must follow PUID/PGID (e.g. the optional workspace-data volume).
# ------------------------------------------------------------------------------
host_bind_mounts_under() {
    local base="$1" _id _parent _dev root mnt _rest
    while read -r _id _parent _dev root mnt _rest; do
        case "$mnt" in
            "$base"/*) ;;
            *) continue ;;
        esac
        case "$root" in
            */volumes/*/_data | */volumes/*/_data/*) continue ;;
        esac
        # /proc encodes spaces etc. as octal escapes (\040) — decode for find
        printf '%b\n' "$mnt"
    done < /proc/self/mountinfo
}

# find -path treats its argument as a glob pattern — escape metacharacters so
# a mount point like ".../proj[v2]" still prunes exactly (an unescaped pattern
# would silently fail to match and the bind would get chowned after all).
glob_escape() {
    local s="$1"
    s=${s//\\/\\\\} # backslash first
    s=${s//\*/\\*}
    s=${s//\?/\\?}
    s=${s//\[/\\[}
    printf '%s' "$s"
}

# Recursive chown of $1 that skips host bind mounts. Non-zero on timeout or
# partial failure (caller falls back to chowning the top level only).
chown_tree() {
    local base="$1" mnt
    local -a prune=()
    while IFS= read -r mnt; do
        echo "[init-permissions]   skipping host bind mount: ${mnt}"
        prune+=(-path "$(glob_escape "$mnt")" -prune -o)
    done < <(host_bind_mounts_under "$base")

    if [[ ${#prune[@]} -eq 0 ]]; then
        timeout 300 chown -R "${PUID}:${PGID}" "$base"
    else
        # -h: chown the symlinks themselves, never their targets (recursive
        # chown does not follow symlinks either). pipefail makes a find
        # timeout (124) fail the pipeline so the caller sees it.
        timeout 300 find "$base" "${prune[@]}" -print0 \
            | xargs -0 -r chown -h "${PUID}:${PGID}"
    fi
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
            if ! chown_tree "$dir"; then
                echo "[init-permissions] WARN: chown timed out or failed for ${dir}, fixing top-level only"
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
