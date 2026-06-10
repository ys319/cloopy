#!/bin/bash
set -euo pipefail

# ==============================================================================
# init-ssh-keys: SSH Host Key Generation & Hardening
# ==============================================================================
# - Installs authorized_keys from the read-only staged public key
# - Generates SSH host keys if missing
# - Writes sshd hardening config
# ==============================================================================

PUBKEY_SRC="/etc/cloopy/authorized_keys"
AUTHORIZED_KEYS="/home/developer/.ssh/authorized_keys"

echo "[init-ssh-keys] Installing authorized_keys"

if [[ ! -s "${PUBKEY_SRC}" ]]; then
    echo "[init-ssh-keys] ERROR: staged public key is empty or missing!"
    echo "[init-ssh-keys]   Run ./manage.sh setup on the host to generate and register the SSH key."
    echo "[init-ssh-keys]   (mounted from CLOOPY_PUBKEY_PATH to ${PUBKEY_SRC})"
    exit 1
fi

# Legacy layouts bind-mounted directly at the target; if the old mount source
# was missing, docker left a directory placeholder in the home volume that
# would make install fail forever. Clear it so the boot is self-healing.
if [[ -d "${AUTHORIZED_KEYS}" ]]; then
    rm -rf "${AUTHORIZED_KEYS}"
fi

# Copy into the home volume instead of using the bind mount in place: sshd
# requires strict owner/perms, and chown/chmod on a bind-mounted file would
# mutate the host's real file. ~/.ssh exists via init-permissions. Runs every
# boot, so host-side key changes propagate on restart (and multiple keys work:
# every line of the staged file ends up in authorized_keys).
install -m 600 -o "${PUID:-1000}" -g "${PGID:-1000}" \
    "${PUBKEY_SRC}" "${AUTHORIZED_KEYS}"

# ------------------------------------------------------------------------------
# Ensure sshd hardening config exists
# ------------------------------------------------------------------------------
# /etc/ssh is a named volume, so COPY'd files from the image may not persist.
# Write the config on every boot to guarantee it.
mkdir -p /etc/ssh/sshd_config.d
cat > /etc/ssh/sshd_config.d/cloopy.conf << 'SSHD_CONF'
PasswordAuthentication no
PermitRootLogin no
PermitEmptyPasswords no
SSHD_CONF

# ------------------------------------------------------------------------------
# Generate SSH host keys
# ------------------------------------------------------------------------------
ssh-keygen -A 2>/dev/null
echo "[init-ssh-keys] Done"
