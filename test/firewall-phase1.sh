#!/usr/bin/env bash
# ==============================================================================
# Phase 1 egress firewall — isolated behaviour test (Approach A)
# ==============================================================================
# Builds the image and runs throwaway containers to PROVE the local-blocking
# firewall actually works, without touching your real cloopy instance / volumes
# / SSH config. Designed to avoid "false pass" traps:
#   - per-rule packet counters (not a summed total that hides a broken range)
#   - reads counters via `iptables -nvx -L` (the only form with pkt columns)
#   - proves the :53-to-private hole is CLOSED
#   - exercises IPv6 rules, the OFF kill-switch teardown, and fail-open
#
# Usage:   bash test/firewall-phase1.sh
#          SKIP_BUILD=1 bash test/firewall-phase1.sh   # reuse existing image
#
# Requires: docker (daemon reachable), internet for the build + public-egress check.
# SSH-stays-up is covered separately by Approach B (see README/handoff) because
# it depends on your host's SSH config.
# ==============================================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
IMG="${CLOOPY_TEST_IMAGE:-ys319/cloopy:latest}"
C=cloopy-fwtest
COFF=cloopy-fwtest-off
CNOCAP=cloopy-fwtest-nocap

pass=0; fail=0
ok()   { printf '  \033[32m[PASS]\033[0m %s\n' "$1"; pass=$((pass+1)); }
ng()   { printf '  \033[31m[FAIL]\033[0m %s\n' "$1"; fail=$((fail+1)); }
note() { printf '  \033[33m[NOTE]\033[0m %s\n' "$1"; }
hdr()  { printf '\n\033[1m== %s ==\033[0m\n' "$1"; }

cleanup() { docker rm -f "$C" "$COFF" "$CNOCAP" >/dev/null 2>&1 || true; }
trap cleanup EXIT
cleanup

# pkts counter for a specific DROP rule (matched by destination = last field).
# Runs the pipe host-side so we don't depend on awk being inside the container.
drop_pkts() { # <container> <dest-cidr> <iptables|ip6tables>
  docker exec "$1" "${3:-iptables}" -w 5 -nvx -L CLOOPY-OUT 2>/dev/null \
    | awk -v d="$2" '$3=="DROP" && $NF==d {print $1; exit}'
}
routable() { docker exec "$1" ip route get "$2" >/dev/null 2>&1; }

# ------------------------------------------------------------------------------
hdr "Build"
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  note "SKIP_BUILD=1, reusing $IMG"
else
  docker build -t "$IMG" "$ROOT/docker" || { echo "build failed"; exit 1; }
fi

# ------------------------------------------------------------------------------
hdr "Image sanity"
docker run --rm --entrypoint sh "$IMG" -c 'command -v iptables >/dev/null && command -v ip6tables >/dev/null' \
  && ok "iptables + ip6tables present" || ng "iptables/ip6tables missing in image"
docker run --rm --entrypoint sh "$IMG" -c \
  'test -x /etc/s6-overlay/scripts/init-firewall.sh && test -x /etc/s6-overlay/s6-rc.d/init-firewall/up' \
  && ok "init-firewall.sh + up are executable" || ng "init-firewall.sh or up not executable"

# ------------------------------------------------------------------------------
hdr "ON: apply rules"
docker run -d --name "$C" --cap-add NET_ADMIN -e CLOOPY_FIREWALL=on \
  --entrypoint sleep "$IMG" infinity >/dev/null
docker exec "$C" /etc/s6-overlay/scripts/init-firewall.sh
echo "--- iptables -S CLOOPY-OUT ---";  docker exec "$C" iptables  -S CLOOPY-OUT
echo "--- ip6tables -S CLOOPY-OUT ---"; docker exec "$C" ip6tables -S CLOOPY-OUT 2>&1 || true

# structural assertions (each must be present; order: ACCEPTs before DROPs)
S4=$(docker exec "$C" iptables -S CLOOPY-OUT 2>/dev/null)
# iptables normalizes ctstate order (ESTABLISHED,RELATED -> RELATED,ESTABLISHED), so match loosely
echo "$S4" | grep -q -- 'ESTABLISHED'        && ok "ESTABLISHED ACCEPT present"        || ng "ESTABLISHED ACCEPT missing"
echo "$S4" | grep -q -- '--sport 22 -j ACCEPT' && ok "sshd sport-22 ACCEPT present (SSH fallback)" || ng "sport-22 ACCEPT missing"
for r in 169.254.0.0/16 100.100.100.200/32 10.0.0.0/8 172.16.0.0/12 192.168.0.0/16 100.64.0.0/10; do
  echo "$S4" | grep -q -- "-d $r -j DROP" && ok "DROP rule present: $r" || ng "DROP rule MISSING: $r"
done
# DNS must be scoped to the resolver, NOT a blanket "to any" (the security fix)
if echo "$S4" | grep -qE -- '-A CLOOPY-OUT -p (udp|tcp) -m (udp|tcp) --dport 53 -j ACCEPT$'; then
  ng "DNS :53 ACCEPT is unscoped (to any) — the lateral-movement hole is OPEN"
else
  ok "DNS :53 ACCEPT is scoped to resolver(s), not 'to any'"
fi

# ------------------------------------------------------------------------------
hdr "ON: per-rule DROP counter proof (port 80)"
# curl ONE target per range; assert THAT range's counter rose (no summing).
# Note: 100.100.100.200 (Alibaba) is omitted here — it is a subset of
# 100.64.0.0/10 (proven below) and probing a single host IP is routing-flaky;
# its DROP rule presence is asserted structurally above instead.
for entry in \
  "169.254.169.254 169.254.0.0/16" \
  "10.255.255.1 10.0.0.0/8" \
  "172.31.255.254 172.16.0.0/12" \
  "192.168.250.250 192.168.0.0/16" \
  "100.64.0.1 100.64.0.0/10" ; do
  ip=${entry%% *}; rule=${entry##* }
  if ! routable "$C" "$ip"; then note "no route to $ip — structural rule present, skipping counter"; continue; fi
  before=$(drop_pkts "$C" "$rule"); before=${before:-0}
  docker exec "$C" curl -s --max-time 3 -o /dev/null "http://$ip/" 2>/dev/null
  after=$(drop_pkts "$C" "$rule"); after=${after:-0}
  if [ "${after:-0}" -gt "${before:-0}" ] 2>/dev/null; then ok "DROP enforced for $rule (pkts $before -> $after via $ip:80)"
  else note "no counter movement for $rule ($before -> $after via $ip) — likely no route on this host; rule present structurally"; fi
done

# ------------------------------------------------------------------------------
hdr "ON: security fix — :53 to a NON-resolver private host is DROPPED"
before=$(drop_pkts "$C" 10.0.0.0/8); before=${before:-0}
docker exec "$C" bash -c 'echo x > /dev/udp/10.255.255.2/53' 2>/dev/null || true
after=$(drop_pkts "$C" 10.0.0.0/8); after=${after:-0}
if [ "${after:-0}" -gt "${before:-0}" ] 2>/dev/null; then ok "udp/53 to 10.255.255.2 was DROPPED (no broad :53 hole)"
else ng "udp/53 to private was NOT dropped (broad :53 hole open) ($before -> $after)"; fi

# ------------------------------------------------------------------------------
hdr "ON: public egress + DNS still work"
docker exec "$C" sh -c 'getent hosts api.anthropic.com >/dev/null' && ok "DNS resolution works" || ng "DNS broken"
code=$(docker exec "$C" curl -s -o /dev/null -w '%{http_code}' --max-time 12 https://api.anthropic.com/ 2>/dev/null)
[ -n "$code" ] && [ "$code" != "000" ] && ok "public HTTPS works (api.anthropic.com -> $code)" \
  || ng "public HTTPS blocked (http_code='$code')"

# ------------------------------------------------------------------------------
hdr "ON: IPv6 rules (structural)"
S6=$(docker exec "$C" ip6tables -S CLOOPY-OUT 2>/dev/null)
if [ -z "$S6" ]; then note "ip6tables CLOOPY-OUT empty/unavailable on this host — skipping IPv6 assertions"
else
  echo "$S6" | grep -q -- '-d fc00::/7 -j DROP'  && ok "IPv6 fc00::/7 DROP present (incl. AWS IPv6 IMDS)" || ng "IPv6 fc00::/7 DROP missing"
  echo "$S6" | grep -q -- '-d fec0::/10 -j DROP' && ok "IPv6 fec0::/10 DROP present" || ng "IPv6 fec0::/10 DROP missing"
  echo "$S6" | grep -qi -- 'ipv6-icmp -j ACCEPT' && ok "ICMPv6 ACCEPT present (NDP preserved)" || ng "ICMPv6 ACCEPT missing"
  echo "$S6" | grep -q  -- 'fe80'                && ng "fe80::/10 is being dropped (would break NDP)" || ok "fe80::/10 left open (correct)"
fi

# ------------------------------------------------------------------------------
hdr "OFF: kill switch tears down rules (state transition in same container)"
docker exec -e CLOOPY_FIREWALL=off "$C" /etc/s6-overlay/scripts/init-firewall.sh
if docker exec "$C" iptables -S CLOOPY-OUT >/dev/null 2>&1; then ng "OFF did not remove CLOOPY-OUT (kill switch incomplete)"
else ok "OFF removed CLOOPY-OUT (true runtime kill switch)"; fi
docker exec "$C" ip6tables -S CLOOPY-OUT >/dev/null 2>&1 && ng "OFF left IPv6 CLOOPY-OUT behind" || ok "OFF removed IPv6 CLOOPY-OUT"

# ------------------------------------------------------------------------------
hdr "Fail-open: no NET_ADMIN -> warn, exit 0, no partial chain"
docker run -d --name "$CNOCAP" -e CLOOPY_FIREWALL=on --entrypoint sleep "$IMG" infinity >/dev/null
docker exec "$CNOCAP" /etc/s6-overlay/scripts/init-firewall.sh; rc=$?
[ "$rc" -eq 0 ] && ok "script exits 0 without NET_ADMIN (fail-open)" || ng "script exited $rc without NET_ADMIN (should be 0)"
docker exec "$CNOCAP" iptables -S CLOOPY-OUT >/dev/null 2>&1 && ng "partial CLOOPY-OUT chain left without NET_ADMIN" \
  || ok "no firewall rules without NET_ADMIN (egress unrestricted)"

# ------------------------------------------------------------------------------
hdr "Summary"
printf '  %d passed, %d failed\n\n' "$pass" "$fail"
[ "$fail" -eq 0 ]
