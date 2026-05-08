#!/bin/bash
set -euo pipefail

# ==============================================================================
# init-firewall: Egress firewall (deny-all + allowlist)
# ==============================================================================
# Modes (CLOOPY_FIREWALL):
#   on  (default) : default-DROP egress, only allowlisted domains/ports allowed
#   off           : permissive, but metadata/private/IPv6 are still blocked
#
# Always-on hardening (both modes):
#   - 169.254.0.0/16  cloud metadata + link-local
#   - 10/8, 172.16/12, 192.168/16  RFC1918 private
#   - 100.64.0.0/10  CGNAT / Tailscale
#   - 100.100.100.200/32  Alibaba metadata
#   - All IPv6 outbound (ip6tables OUTPUT DROP)
#
# Capability requirement: NET_ADMIN on the container.
# ==============================================================================

FIREWALL_MODE="${CLOOPY_FIREWALL:-on}"
ALLOWED_DOMAINS_FILE="/etc/cloopy/firewall/allowed-domains.txt"
EXTRA_DOMAINS="${CLOOPY_EXTRA_DOMAINS:-}"
IPSET_NAME="cloopy-allowed"
DOMAINS_RUNTIME_FILE="/run/cloopy-firewall-domains.txt"

echo "[init-firewall] Mode: ${FIREWALL_MODE}"

# ------------------------------------------------------------------------------
# Reset chains (idempotent on container restart)
# ------------------------------------------------------------------------------
iptables -P OUTPUT ACCEPT
iptables -F OUTPUT
ip6tables -F OUTPUT 2>/dev/null || true
ip6tables -F INPUT 2>/dev/null || true
ip6tables -F FORWARD 2>/dev/null || true

# ------------------------------------------------------------------------------
# Always-on: block all IPv6 outbound
# ------------------------------------------------------------------------------
# Skipping ip6tables policy DROP would silently bypass the IPv4 allowlist
# whenever a destination resolves to an AAAA record.
ip6tables -P INPUT DROP 2>/dev/null || true
ip6tables -P FORWARD DROP 2>/dev/null || true
ip6tables -P OUTPUT DROP 2>/dev/null || true

# ------------------------------------------------------------------------------
# Loopback first (Docker embedded DNS lives on 127.0.0.11)
# ------------------------------------------------------------------------------
iptables -A OUTPUT -o lo -j ACCEPT

# ------------------------------------------------------------------------------
# Always-on: metadata services and private ranges
# Order matters: these DROPs precede any ACCEPTs so they cannot be bypassed.
# ------------------------------------------------------------------------------
iptables -A OUTPUT -d 169.254.0.0/16     -j DROP   # cloud metadata + link-local
iptables -A OUTPUT -d 10.0.0.0/8         -j DROP   # RFC1918
iptables -A OUTPUT -d 172.16.0.0/12      -j DROP   # RFC1918
iptables -A OUTPUT -d 192.168.0.0/16     -j DROP   # RFC1918
iptables -A OUTPUT -d 100.64.0.0/10      -j DROP   # CGNAT / Tailscale
iptables -A OUTPUT -d 100.100.100.200/32 -j DROP   # Alibaba metadata

if [ "$FIREWALL_MODE" = "off" ]; then
    iptables -P OUTPUT ACCEPT
    echo "[init-firewall] Allowlist disabled. Metadata/private/IPv6 DROP active."
    exit 0
fi

# ------------------------------------------------------------------------------
# Allowlist mode: build ipset of resolved IPs
# ------------------------------------------------------------------------------
ipset destroy "$IPSET_NAME" 2>/dev/null || true
ipset create  "$IPSET_NAME" hash:ip family inet maxelem 65536

# Compose domain list: defaults + user-supplied (CLOOPY_EXTRA_DOMAINS, comma-sep)
{
    grep -vE '^\s*(#|$)' "$ALLOWED_DOMAINS_FILE" || true
    printf '%s\n' "$EXTRA_DOMAINS" | tr ',' '\n'
} | sed 's/[[:space:]]//g' | grep -vE '^$' | sort -u > "$DOMAINS_RUNTIME_FILE"

resolved=0
domains=0
while IFS= read -r domain; do
    domains=$((domains + 1))
    # IPv4 only — IPv6 is fully blocked above.
    ips=$(getent ahostsv4 "$domain" 2>/dev/null | awk '{print $1}' | sort -u || true)
    if [ -z "$ips" ]; then
        echo "[init-firewall] WARN: failed to resolve ${domain}"
        continue
    fi
    while IFS= read -r ip; do
        [ -z "$ip" ] && continue
        ipset add "$IPSET_NAME" "$ip" -exist
        resolved=$((resolved + 1))
    done <<< "$ips"
done < "$DOMAINS_RUNTIME_FILE"

echo "[init-firewall] Resolved ${resolved} IPs across ${domains} domains"

# ------------------------------------------------------------------------------
# Allow rules
# ------------------------------------------------------------------------------
# DNS to public resolvers (Docker embedded DNS is on lo, already allowed).
for resolver in 1.1.1.1 1.0.0.1 8.8.8.8 8.8.4.4; do
    iptables -A OUTPUT -p udp --dport 53 -d "$resolver" -j ACCEPT
    iptables -A OUTPUT -p tcp --dport 53 -d "$resolver" -j ACCEPT
done

# Allowlisted destinations on standard egress ports.
#   443: HTTPS  80: HTTP  22: git+ssh  9418: git://
for port in 443 80 22 9418; do
    iptables -A OUTPUT -p tcp --dport "$port" \
        -m set --match-set "$IPSET_NAME" dst -j ACCEPT
done

# Return traffic for established outbound connections.
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT

# Default DROP
iptables -P OUTPUT DROP

echo "[init-firewall] Allowlist active"
