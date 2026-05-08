#!/bin/bash
set -uo pipefail

# ==============================================================================
# firewall-refresh: Periodic re-resolution of allowlisted domains
# ==============================================================================
# CDNs (GitHub, npm, PyPI) rotate IPs frequently. ipset entries set at boot
# expire in practice — this longrun re-resolves the same domain list on a
# fixed interval and adds any new IPs to the set. Existing entries stay
# (we never shrink the set within a session).
#
# No-op when CLOOPY_FIREWALL=off — init-firewall did not create the set.
# ==============================================================================

FIREWALL_MODE="${CLOOPY_FIREWALL:-on}"
IPSET_NAME="cloopy-allowed"
DOMAINS_FILE="/run/cloopy-firewall-domains.txt"
INTERVAL="${CLOOPY_FIREWALL_REFRESH_SECONDS:-900}"   # 15 min default

if [ "$FIREWALL_MODE" = "off" ]; then
    echo "[firewall-refresh] Disabled (CLOOPY_FIREWALL=off). Sleeping forever."
    exec sleep infinity
fi

if [ ! -s "$DOMAINS_FILE" ]; then
    echo "[firewall-refresh] ERROR: ${DOMAINS_FILE} missing or empty"
    exit 1
fi

echo "[firewall-refresh] Refreshing every ${INTERVAL}s"

while true; do
    sleep "$INTERVAL"

    added=0
    while IFS= read -r domain; do
        ips=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u || true)
        [ -z "$ips" ] && continue
        while IFS= read -r ip; do
            [ -z "$ip" ] && continue
            # `ipset add -exist` returns 0 even when entry already exists,
            # so we can't tell new from existing without an extra `test`.
            if ! ipset test "$IPSET_NAME" "$ip" 2>/dev/null; then
                if ipset add "$IPSET_NAME" "$ip" -exist 2>/dev/null; then
                    added=$((added + 1))
                fi
            fi
        done <<< "$ips"
    done < "$DOMAINS_FILE"

    if [ "$added" -gt 0 ]; then
        echo "[firewall-refresh] Added ${added} new IP(s)"
    fi
done
