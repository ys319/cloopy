#!/usr/bin/env bash
# ==============================================================================
# DNS pinning + host-allow — isolated behaviour test (Approach A)
# ==============================================================================
# Proves the layer-2 firewall behaviour added on top of local blocking:
#   - :53 is ACCEPTed only to the configured filtering resolver(s)
#   - :53 to any other resolver (e.g. 8.8.8.8) is DROPped (the "pin")
#   - host.docker.internal is ACCEPTed *before* the private-range DROPs
#   - with no CLOOPY_DNS_* set, it degrades to the no-pin fallback (DNS unbroken)
#
# Uses throwaway containers on the default bridge with `--dns <filter>` so the
# resolver is the filter IP directly (no embedded-DNS indirection) — this makes
# the pin directly observable. The real cloopy (Compose embedded DNS) is covered
# by Approach B (live `ssh cloopy` + a malicious-domain lookup).
#
# Usage:   bash test/firewall-dns.sh
#          SKIP_BUILD=1 bash test/firewall-dns.sh   # reuse existing image
# ==============================================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${CLOOPY_TEST_IMAGE:-ys319/cloopy:latest}"
DNS1="${CLOOPY_DNS_PRIMARY:-1.1.1.2}"
DNS2="${CLOOPY_DNS_SECONDARY:-1.0.0.2}"
C=cloopy-dnstest
CFB=cloopy-dnstest-fallback

pass=0; fail=0
ok()   { printf '  \033[32m[PASS]\033[0m %s\n' "$1"; pass=$((pass+1)); }
ng()   { printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; fail=$((fail+1)); }
note() { printf '  \033[33m[NOTE]\033[0m %s\n' "$1"; }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

cleanup() { docker rm -f "$C" "$CFB" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# Sum of pkts across every DROP rule that targets :53 (the pin). Runs the awk
# host-side so we don't depend on awk being inside the container.
dns_drop_pkts() { # <container>
  docker exec "$1" iptables -w 5 -nvx -L CLOOPY-OUT 2>/dev/null \
    | awk '$3=="DROP" && /dpt:53/ {s+=$1} END{print s+0}'
}

# ------------------------------------------------------------------------------
hdr "Build"
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  note "SKIP_BUILD=1, reusing $IMG"
else
  docker build -t "$IMG" "$ROOT/docker" || { echo "build failed"; exit 1; }
fi

# ------------------------------------------------------------------------------
hdr "Pinned mode: apply rules (filter=$DNS1,$DNS2)"
docker run -d --name "$C" --cap-add NET_ADMIN \
  --add-host host.docker.internal:host-gateway \
  --dns "$DNS1" --dns "$DNS2" \
  -e CLOOPY_FIREWALL=on -e CLOOPY_ALLOW_HOST=on \
  -e CLOOPY_DNS_PRIMARY="$DNS1" -e CLOOPY_DNS_SECONDARY="$DNS2" \
  --entrypoint sleep "$IMG" infinity >/dev/null
docker exec "$C" /etc/s6-overlay/scripts/init-firewall.sh
echo "--- iptables -S CLOOPY-OUT ---"; docker exec "$C" iptables -S CLOOPY-OUT
S4=$(docker exec "$C" iptables -S CLOOPY-OUT 2>/dev/null)

# --- structural: filter ACCEPT + the :53 pin DROP ---
echo "$S4" | grep -qE -- "-d ${DNS1}(/32)? -p udp -m udp --dport 53 -j ACCEPT" \
  && ok "filter :53 ACCEPT present ($DNS1 udp)" || ng "filter :53 ACCEPT missing ($DNS1 udp)"
echo "$S4" | grep -qE -- '-p udp -m udp --dport 53 -j DROP' \
  && ok "udp :53 pin DROP present (other resolvers blocked)" || ng "udp :53 pin DROP missing"
echo "$S4" | grep -qE -- '-p tcp -m tcp --dport 53 -j DROP' \
  && ok "tcp :53 pin DROP present" || ng "tcp :53 pin DROP missing"

# --- structural: host.docker.internal ACCEPT, before any DROP ---
# host.docker.internal may resolve to IPv4 and/or IPv6 depending on the host
# (Docker Desktop here yields an IPv6 ULA, which lives inside the fc00::/7 DROP
# range — so the ACCEPT MUST precede that DROP). Assert each resolved IP in its
# matching chain.
HIPS=$(docker exec "$C" getent hosts host.docker.internal 2>/dev/null | awk '{print $1}')
S6=$(docker exec "$C" ip6tables -S CLOOPY-OUT 2>/dev/null)
if [ -z "$HIPS" ]; then
  note "host.docker.internal did not resolve on this host — skipping host-allow assertions"
else
  for hip in $HIPS; do
    case "$hip" in
      *:*) chain="$S6"; fam="IPv6"; mask="/128" ;;
      *)   chain="$S4"; fam="IPv4"; mask="/32"  ;;
    esac
    echo "$chain" | grep -qE -- "-d ${hip}(${mask})? -j ACCEPT" \
      && ok "host.docker.internal ($hip, $fam) ACCEPT present" \
      || ng "host.docker.internal ($hip, $fam) ACCEPT missing"
    host_line=$(echo "$chain" | grep -nE -- "-d ${hip}(${mask})? -j ACCEPT" | head -1 | cut -d: -f1)
    first_drop=$(echo "$chain" | grep -n -- '-j DROP' | head -1 | cut -d: -f1)
    if [ -n "$host_line" ] && [ -n "$first_drop" ] && [ "$host_line" -lt "$first_drop" ]; then
      ok "host ACCEPT (line $host_line) precedes first DROP (line $first_drop) [$fam]"
    else
      ng "host ACCEPT ordering wrong ($fam: host=$host_line firstDrop=$first_drop) — would be blocked"
    fi
  done
fi

# ------------------------------------------------------------------------------
hdr "Pinned mode: :53 to a NON-filter resolver (8.8.8.8) is DROPped"
before=$(dns_drop_pkts "$C"); before=${before:-0}
docker exec "$C" bash -c 'echo x > /dev/udp/8.8.8.8/53' 2>/dev/null || true
after=$(dns_drop_pkts "$C"); after=${after:-0}
if [ "${after:-0}" -gt "${before:-0}" ] 2>/dev/null; then
  ok "udp/53 to 8.8.8.8 was DROPPED by the pin ($before -> $after)"
else
  ng "udp/53 to 8.8.8.8 was NOT dropped — pin ineffective ($before -> $after)"
fi

# ------------------------------------------------------------------------------
hdr "Pinned mode: resolution via the filter + public egress still work"
docker exec "$C" sh -c 'getent hosts api.anthropic.com >/dev/null' \
  && ok "DNS resolves via filter ($DNS1)" || ng "DNS broken through the filter"
code=$(docker exec "$C" curl -s -o /dev/null -w '%{http_code}' --max-time 12 https://api.anthropic.com/ 2>/dev/null)
[ -n "$code" ] && [ "$code" != "000" ] && ok "public HTTPS works (api.anthropic.com -> $code)" \
  || ng "public HTTPS blocked (http_code='$code')"
note "actual malware-domain blocking is the resolver's job (Cloudflare/Quad9) — verify live via Approach B"

# ------------------------------------------------------------------------------
hdr "Fallback mode: no CLOOPY_DNS_* -> no :53 pin DROP (DNS must not break)"
# No --add-host here on purpose: this container only verifies the absence of
# the :53 pin DROP; host.docker.internal handling is covered above.
docker run -d --name "$CFB" --cap-add NET_ADMIN \
  -e CLOOPY_FIREWALL=on \
  --entrypoint sleep "$IMG" infinity >/dev/null
docker exec "$CFB" /etc/s6-overlay/scripts/init-firewall.sh >/dev/null
SFB=$(docker exec "$CFB" iptables -S CLOOPY-OUT 2>/dev/null)
if echo "$SFB" | grep -qE -- '-p (udp|tcp) -m (udp|tcp) --dport 53 -j DROP'; then
  ng "fallback added a :53 DROP (would break DNS when no filter configured)"
else
  ok "fallback has no :53 pin DROP (DNS preserved)"
fi
docker exec "$CFB" sh -c 'getent hosts api.anthropic.com >/dev/null' \
  && ok "fallback DNS resolution works" || ng "fallback DNS broken"

# ------------------------------------------------------------------------------
hdr "Summary"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
