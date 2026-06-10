#!/bin/bash
# ==============================================================================
# init-firewall: Egress Network Isolation (private-block + filtering DNS)
# ==============================================================================
# Restricts the container's outbound traffic. Two always-on layers:
#   1. Local blocking — DROP egress to cloud metadata services and private
#      (RFC 1918 / CGN / link-local) networks. Stops IMDS credential theft and
#      lateral movement into the host LAN. Public internet egress stays open.
#   2. DNS pinning — force name resolution through a configurable malware-
#      filtering resolver (default Cloudflare for Families 1.1.1.2) and DROP
#      :53 to everything else, so known-malicious domains are blocked at
#      resolution and a process cannot switch to an unfiltered resolver.
# The Docker host (host.docker.internal) is exempted from layer 1 so host
# services stay reachable (CLOOPY_ALLOW_HOST=on).
#
# Design notes (see also CLAUDE.md / README threat model):
#   - Only the OUTPUT chain is touched. INPUT is left alone so inbound SSH
#     is never affected.
#   - The default OUTPUT policy stays ACCEPT — this is NOT a deny-all allowlist
#     (intentionally dropped as too much for cloopy). We add targeted rules in
#     a dedicated CLOOPY-OUT chain.
#   - ACCEPT exceptions come *before* the DROP rules so SSH return traffic and
#     name resolution keep working:
#       * loopback (Docker embedded DNS 127.0.0.11)
#       * ESTABLISHED,RELATED (return traffic for any tracked connection)
#       * tcp --sport 22 (sshd replies — belt-and-suspenders so inbound SSH
#         survives even if conntrack/ESTABLISHED is unavailable; SSH replies
#         target the private docker gateway and would otherwise be DROPped)
#       * host.docker.internal (the Docker host gateway)
#       * DNS(53) ONLY to the filtering resolver(s); all other :53 is DROPped
#   - Fail-open: if iptables can't be managed (e.g. NET_ADMIN missing) we
#     warn loudly and exit 0 rather than killing the container. Losing the
#     firewall must never lock the user out of cloopy.
#
# IMPORTANT: this script intentionally does NOT use `set -e`. We handle
# errors explicitly so a single failed rule cannot abort the container boot.
# ==============================================================================

FIREWALL_MODE="${CLOOPY_FIREWALL:-on}"

# Allow reaching the Docker host (host.docker.internal). Default on.
ALLOW_HOST="${CLOOPY_ALLOW_HOST:-on}"

# Filtering DNS resolver(s) to pin :53 to. When set, name resolution is forced
# through these IPs only (see apply_v4/apply_v6) and all other :53 is dropped.
# Defaults are injected by docker-compose; if unset, DNS degrades gracefully to
# resolv.conf-scoped behavior (no :53 DROP) so resolution never breaks.
DNS_V4=()
[ -n "${CLOOPY_DNS_PRIMARY:-}" ]      && DNS_V4+=("${CLOOPY_DNS_PRIMARY}")
[ -n "${CLOOPY_DNS_SECONDARY:-}" ]    && DNS_V4+=("${CLOOPY_DNS_SECONDARY}")
DNS_V6=()
[ -n "${CLOOPY_DNS_V6_PRIMARY:-}" ]   && DNS_V6+=("${CLOOPY_DNS_V6_PRIMARY}")
[ -n "${CLOOPY_DNS_V6_SECONDARY:-}" ] && DNS_V6+=("${CLOOPY_DNS_V6_SECONDARY}")

log() { echo "[init-firewall] $*"; }

# ------------------------------------------------------------------------------
# Remove our chain (idempotent teardown) for a given iptables command
# ------------------------------------------------------------------------------
teardown_one() {
    local ipt="$1"
    $ipt -S CLOOPY-OUT >/dev/null 2>&1 || return 0
    $ipt -D OUTPUT -j CLOOPY-OUT 2>/dev/null
    $ipt -F CLOOPY-OUT 2>/dev/null
    $ipt -X CLOOPY-OUT 2>/dev/null
}

# ------------------------------------------------------------------------------
# Kill switch
# ------------------------------------------------------------------------------
# NOTE: CLOOPY_FIREWALL=off disables everything (local blocking AND the DNS
# pin) and tears down any existing CLOOPY-OUT rules, acting as a full kill
# switch. This prioritizes guaranteed connectivity — losing the firewall must
# never lock the user out of cloopy.
if [ "$FIREWALL_MODE" = "off" ]; then
    log "CLOOPY_FIREWALL=off — egress filtering disabled (removing any existing rules)"
    teardown_one "iptables -w 5"
    command -v ip6tables >/dev/null 2>&1 && teardown_one "ip6tables -w 5"
    exit 0
fi

# ------------------------------------------------------------------------------
# Metadata / private network ranges to block (egress only)
# ------------------------------------------------------------------------------
# IPv4 — these DROPs are appended to CLOOPY-OUT *after* all ACCEPTs in
# apply_v4 (lo / conntrack / sport 22 / host / DNS pin), so an earlier ACCEPT
# always wins; order among the DROPs themselves is irrelevant (all terminate).
# 100.100.100.200 (Alibaba IMDS) is technically already inside 100.64.0.0/10,
# but kept explicit and first so it gets its own counter.
DROP_V4=(
    169.254.0.0/16     # link-local incl. 169.254.169.254 (AWS/GCP/Azure IMDS)
    100.100.100.200/32 # Alibaba Cloud metadata (subset of 100.64.0.0/10 below)
    10.0.0.0/8         # RFC 1918 private
    172.16.0.0/12      # RFC 1918 private
    192.168.0.0/16     # RFC 1918 private
    100.64.0.0/10      # CGNAT / Tailscale
)

# IPv6 — fc00::/7 covers Unique Local Addresses, including AWS IPv6 IMDS
# (fd00:ec2::254). fe80::/10 (link-local) is INTENTIONALLY left open so NDP/RA
# keep working — do not "fix" this, it would break IPv6.
DROP_V6=(
    fc00::/7           # Unique Local Addresses (private), incl. IPv6 IMDS
    fec0::/10          # deprecated site-local (defense-in-depth)
)

# ------------------------------------------------------------------------------
# Nameservers from /etc/resolv.conf (so DNS keeps working to a private resolver
# without opening :53 to every host). Split by address family.
# ------------------------------------------------------------------------------
# (no awk dependency — the minimal base image may not ship it; a missing awk
# would silently drop us into the broad-DNS fallback and reopen the :53 hole)
_resolvers() {
    local want="$1" _kw ip _rest
    grep '^nameserver' /etc/resolv.conf 2>/dev/null | while read -r _kw ip _rest; do
        case "$ip" in
            *:*) [ "$want" = v6 ] && echo "$ip" ;;  # IPv6
            *)   [ "$want" = v4 ] && echo "$ip" ;;  # IPv4
        esac
    done | sort -u
}
resolvers_v4() { _resolvers v4; }
resolvers_v6() { _resolvers v6; }

# ------------------------------------------------------------------------------
# Docker host (host.docker.internal) IPs, split by address family. Resolved via
# /etc/hosts (populated by `extra_hosts: host.docker.internal:host-gateway`).
# getent consults files before DNS, so this works at boot before our resolver
# is configured. Empty on hosts where the name is not defined.
# ------------------------------------------------------------------------------
_host_ips() {
    local want="$1" ip _rest
    getent hosts host.docker.internal 2>/dev/null | while read -r ip _rest; do
        case "$ip" in
            *:*) [ "$want" = v6 ] && echo "$ip" ;;  # IPv6
            *)   [ "$want" = v4 ] && echo "$ip" ;;  # IPv4
        esac
    done | sort -u
}

# ------------------------------------------------------------------------------
# IPv4 rules
# ------------------------------------------------------------------------------
apply_v4() {
    local ipt="iptables -w 5"

    # Capability probe — if this fails we cannot manage iptables at all.
    if ! $ipt -S OUTPUT >/dev/null 2>&1; then
        log "WARN: cannot manage iptables (NET_ADMIN missing?). IPv4 egress is NOT restricted."
        return 1
    fi

    # Idempotent: keep all our rules in a dedicated chain jumped to from OUTPUT.
    $ipt -N CLOOPY-OUT 2>/dev/null || $ipt -F CLOOPY-OUT
    $ipt -C OUTPUT -j CLOOPY-OUT 2>/dev/null || $ipt -I OUTPUT 1 -j CLOOPY-OUT

    # --- ACCEPT (must precede DROPs) ---
    $ipt -A CLOOPY-OUT -o lo -j ACCEPT
    $ipt -A CLOOPY-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # SSH reply fallback: survives even if the conntrack match is unavailable.
    $ipt -A CLOOPY-OUT -p tcp --sport 22 -j ACCEPT

    # Allow the Docker host (host.docker.internal). It resolves to a private IP
    # that the DROP rules below would otherwise block, so ACCEPT it up front.
    # Gated by CLOOPY_ALLOW_HOST (default on).
    if [ "$ALLOW_HOST" = "on" ]; then
        local h
        for h in $(_host_ips v4); do
            $ipt -A CLOOPY-OUT -d "$h" -j ACCEPT
            log "allow host.docker.internal -> $h (IPv4)"
        done
    fi

    # DNS pinning: force name resolution through the configured filtering
    # resolver(s) only, and DROP :53 to everything else, so a process cannot
    # switch to an unfiltered resolver (e.g. 8.8.8.8) and bypass the malware
    # filter. Loopback (Docker embedded DNS 127.0.0.11) is already accepted via
    # -o lo above; it forwards upstream to these same IPs.
    if [ ${#DNS_V4[@]} -gt 0 ]; then
        local d
        for d in "${DNS_V4[@]}"; do
            $ipt -A CLOOPY-OUT -d "$d" -p udp --dport 53 -j ACCEPT
            $ipt -A CLOOPY-OUT -d "$d" -p tcp --dport 53 -j ACCEPT
        done
        $ipt -A CLOOPY-OUT -p udp --dport 53 -j DROP
        $ipt -A CLOOPY-OUT -p tcp --dport 53 -j DROP
        log "DNS pinned to filtering resolver(s): ${DNS_V4[*]}"
    else
        # No filtering resolver configured: fall back to the original behavior —
        # scope :53 ACCEPT to /etc/resolv.conf resolvers and do NOT drop other
        # :53 (so DNS keeps working even in this degenerate case).
        local r resolvers; resolvers=$(resolvers_v4)
        if [ -n "$resolvers" ]; then
            for r in $resolvers; do
                $ipt -A CLOOPY-OUT -d "$r" -p udp --dport 53 -j ACCEPT
                $ipt -A CLOOPY-OUT -d "$r" -p tcp --dport 53 -j ACCEPT
            done
        else
            log "WARN: no IPv4 nameserver in /etc/resolv.conf; allowing DNS to any (fallback)"
            $ipt -A CLOOPY-OUT -p udp --dport 53 -j ACCEPT
            $ipt -A CLOOPY-OUT -p tcp --dport 53 -j ACCEPT
        fi
    fi

    # --- DROP metadata / private ranges (new outbound connections) ---
    local net
    for net in "${DROP_V4[@]}"; do
        $ipt -A CLOOPY-OUT -d "$net" -j DROP
    done

    # Verify the ESTABLISHED guard actually landed (conntrack may be missing).
    if ! $ipt -S CLOOPY-OUT 2>/dev/null | grep -q 'ESTABLISHED'; then
        log "WARN: ESTABLISHED,RELATED ACCEPT not present (conntrack unavailable?); SSH relies on --sport 22 fallback"
    fi

    # No terminating rule at the end → unmatched packets RETURN to OUTPUT and
    # hit the default ACCEPT policy (public internet egress stays open).
    log "IPv4 local blocking applied"
    return 0
}

# ------------------------------------------------------------------------------
# IPv6 rules
# ------------------------------------------------------------------------------
apply_v6() {
    command -v ip6tables >/dev/null 2>&1 || { log "ip6tables not available, skipping IPv6"; return 0; }
    local ipt="ip6tables -w 5"

    if ! $ipt -S OUTPUT >/dev/null 2>&1; then
        log "WARN: cannot manage ip6tables. IPv6 egress is NOT restricted."
        return 1
    fi

    $ipt -N CLOOPY-OUT 2>/dev/null || $ipt -F CLOOPY-OUT
    $ipt -C OUTPUT -j CLOOPY-OUT 2>/dev/null || $ipt -I OUTPUT 1 -j CLOOPY-OUT

    $ipt -A CLOOPY-OUT -o lo -j ACCEPT
    $ipt -A CLOOPY-OUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
    # ICMPv6 (NDP/RA/PMTU) is required for IPv6 to function at all.
    $ipt -A CLOOPY-OUT -p ipv6-icmp -j ACCEPT
    $ipt -A CLOOPY-OUT -p tcp --sport 22 -j ACCEPT

    # Allow the Docker host over IPv6 (host.docker.internal), gated by
    # CLOOPY_ALLOW_HOST.
    if [ "$ALLOW_HOST" = "on" ]; then
        local h
        for h in $(_host_ips v6); do
            $ipt -A CLOOPY-OUT -d "$h" -j ACCEPT
            log "allow host.docker.internal -> $h (IPv6)"
        done
    fi

    # DNS pinning over IPv6 (same rationale as IPv4). If no IPv6 filtering
    # resolver is configured, fall back to resolv.conf-scoped :53 ACCEPT without
    # a blanket :53 DROP (IPv6 DNS, if any, keeps working).
    if [ ${#DNS_V6[@]} -gt 0 ]; then
        local d
        for d in "${DNS_V6[@]}"; do
            $ipt -A CLOOPY-OUT -d "$d" -p udp --dport 53 -j ACCEPT
            $ipt -A CLOOPY-OUT -d "$d" -p tcp --dport 53 -j ACCEPT
        done
        $ipt -A CLOOPY-OUT -p udp --dport 53 -j DROP
        $ipt -A CLOOPY-OUT -p tcp --dport 53 -j DROP
        log "IPv6 DNS pinned to filtering resolver(s): ${DNS_V6[*]}"
    else
        local r resolvers; resolvers=$(resolvers_v6)
        for r in $resolvers; do
            $ipt -A CLOOPY-OUT -d "$r" -p udp --dport 53 -j ACCEPT
            $ipt -A CLOOPY-OUT -d "$r" -p tcp --dport 53 -j ACCEPT
        done
    fi

    local net
    for net in "${DROP_V6[@]}"; do
        $ipt -A CLOOPY-OUT -d "$net" -j DROP
    done

    if ! $ipt -S CLOOPY-OUT 2>/dev/null | grep -q 'ESTABLISHED'; then
        log "WARN: IPv6 ESTABLISHED,RELATED ACCEPT not present; SSH-over-IPv6 relies on --sport 22 fallback"
    fi

    log "IPv6 local blocking applied"
    return 0
}

# ------------------------------------------------------------------------------
# Main
# ------------------------------------------------------------------------------
SECONDS=0
log "Applying egress filtering (metadata/private blocking + DNS pinning)"
log "iptables: $(iptables -V 2>/dev/null || echo unknown)"

apply_v4 || true
apply_v6 || true

# Dump the resulting chains so users can verify / debug from logs.
if iptables -w 5 -S CLOOPY-OUT >/dev/null 2>&1; then
    log "Active IPv4 rules:"
    iptables -w 5 -S CLOOPY-OUT | sed 's/^/[init-firewall]   /'
fi
if command -v ip6tables >/dev/null 2>&1 && ip6tables -w 5 -S CLOOPY-OUT >/dev/null 2>&1; then
    log "Active IPv6 rules:"
    ip6tables -w 5 -S CLOOPY-OUT | sed 's/^/[init-firewall]   /'
fi

log "Done in ${SECONDS}s"
exit 0
