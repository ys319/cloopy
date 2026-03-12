#!/bin/bash
set -euo pipefail

# ==============================================================================
# init-ssh-keys: SSH Host Key Generation & Hardening
# ==============================================================================
# - authorized_keys is bind-mounted from host (read-only)
# - Generates SSH host keys if missing
# - Writes sshd hardening config
# ==============================================================================

AUTHORIZED_KEYS="/home/developer/.ssh/authorized_keys"

echo "[init-ssh-keys] Checking authorized_keys"

if [[ ! -s "${AUTHORIZED_KEYS}" ]]; then
    echo "[init-ssh-keys] WARNING: authorized_keys is empty or missing!"
    echo "[init-ssh-keys]   Ensure ~/.ssh/cloopy/id_ed25519.pub exists on the host."
else
    # sshd requires strict ownership and permissions on authorized_keys
    chown "${PUID:-1000}:${PGID:-1000}" "${AUTHORIZED_KEYS}"
    chmod 600 "${AUTHORIZED_KEYS}"
fi

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
