#!/bin/bash
# ==============================================================================
# init-firewall: Egress Network Isolation (Phase 1 — Local Blocking)
# ==============================================================================
# Blocks the container from reaching cloud metadata services and private
# (RFC 1918 / CGN / link-local) networks. This is the "must-have" layer:
# it stops IMDS credential theft and lateral movement into the host LAN,
# while leaving public internet egress untouched.
#
# Design notes (see also CLAUDE.md / README threat model):
#   - Only the OUTPUT chain is touched. INPUT is left alone so inbound SSH
#     is never affected.
#   - The default OUTPUT policy stays ACCEPT. We do NOT deny-all here — that
#     (allowlist) is a later phase. Phase 1 only adds targeted DROP rules.
#   - ACCEPT exceptions come *before* the DROP rules so SSH return traffic
#     and name resolution keep working:
#       * loopback (Docker embedded DNS 127.0.0.11)
#       * ESTABLISHED,RELATED (return traffic for any tracked connection)
#       * tcp --sport 22 (sshd replies — belt-and-suspenders so inbound SSH
#         survives even if conntrack/ESTABLISHED is unavailable; SSH replies
#         target the private docker gateway and would otherwise be DROPped)
#       * DNS(53) ONLY to the resolvers in /etc/resolv.conf (so DNS works even
#         when the resolver is a private IP, without opening :53 to all hosts)
#   - Fail-open: if iptables can't be managed (e.g. NET_ADMIN missing) we
#     warn loudly and exit 0 rather than killing the container. Losing the
#     firewall must never lock the user out of cloopy.
#
# IMPORTANT: this script intentionally does NOT use `set -e`. We handle
# errors explicitly so a single failed rule cannot abort the container boot.
# ==============================================================================

FIREWALL_MODE="${CLOOPY_FIREWALL:-on}"

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
# NOTE: in this phase CLOOPY_FIREWALL=off disables local blocking too, acting
# as a full kill switch. This prioritizes guaranteed connectivity. When the
# egress allowlist lands in a later phase, local blocking becomes always-on
# and this flag will gate only the allowlist.
if [ "$FIREWALL_MODE" = "off" ]; then
    log "CLOOPY_FIREWALL=off — egress filtering disabled (removing any existing rules)"
    teardown_one "iptables -w 5"
    command -v ip6tables >/dev/null 2>&1 && teardown_one "ip6tables -w 5"
    exit 0
fi

# ------------------------------------------------------------------------------
# Metadata / private network ranges to block (egress only)
# ------------------------------------------------------------------------------
# IPv4 — order among DROPs is irrelevant (all terminate), but every ACCEPT
# below must come first. 100.100.100.200 (Alibaba IMDS) is technically already
# inside 100.64.0.0/10, but kept explicit and first so it gets its own counter.
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

    # DNS only to the configured resolver(s); fallback to any if none parsed
    # (DNS would be broken regardless in that degenerate case).
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

    # DNS only to configured IPv6 resolver(s). No fallback: if there is no IPv6
    # nameserver, IPv6 DNS is simply not used (resolution goes over IPv4).
    local r resolvers; resolvers=$(resolvers_v6)
    for r in $resolvers; do
        $ipt -A CLOOPY-OUT -d "$r" -p udp --dport 53 -j ACCEPT
        $ipt -A CLOOPY-OUT -d "$r" -p tcp --dport 53 -j ACCEPT
    done

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
log "Applying egress local blocking (metadata + private networks)"
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
