#!/usr/bin/env bash
# ==============================================================================
# cloopy cold-start timing — pure stop -> start -> ssh-poll loop (no manage.sh)
# ==============================================================================
# Measures how long it takes from `docker compose up -d` until SSH is reachable,
# bypassing manage.sh entirely (which uses `up --wait` and can mask/inflate the
# wait). Volumes are preserved (no -v), so this reproduces a normal cold start.
# After SSH is ready it dumps the timestamped boot phases so we can see WHICH
# phase eats the time (the usual suspect is init-permissions' recursive chown).
#
# Usage:
#   bash test/boot-timing.sh                 # one cold start
#   ITER=3 bash test/boot-timing.sh          # repeat 3x (check consistency)
#   SSH_TARGET=cloopy bash test/boot-timing.sh   # override ssh host alias
#   MAX_WAIT=600 bash test/boot-timing.sh    # seconds to wait for ssh
#
# NOTE: this STOPS and restarts your cloopy container each iteration.
# ==============================================================================
set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT" || exit 1

SSH_TARGET="${SSH_TARGET:-cloopy}"
ITER="${ITER:-1}"
MAX_WAIT="${MAX_WAIT:-600}"
POLL="${POLL:-2}"

# Match the CLI: include docker-compose.local.yml if present.
CF=(-f docker-compose.yml)
[ -f docker-compose.local.yml ] && CF+=(-f docker-compose.local.yml)
dc() { docker compose "${CF[@]}" "$@"; }

ssh_ok() {
  ssh -o ConnectTimeout=3 -o BatchMode=yes -o StrictHostKeyChecking=accept-new \
      "$SSH_TARGET" exit >/dev/null 2>&1
}

run_once() {
  local n="$1" t0 tup tssh waited=0 ok=0
  echo "================ cold start #$n ================"

  echo "[down] stopping container (volumes preserved)..."
  dc down >/dev/null 2>&1

  t0=$(date +%s)
  echo "[up] docker compose up -d (no --wait)..."
  dc up -d >/dev/null 2>&1
  tup=$(date +%s)
  echo "[up] returned after $((tup - t0))s"

  echo "[poll] waiting for ssh '$SSH_TARGET' (max ${MAX_WAIT}s, every ${POLL}s)..."
  while [ "$waited" -lt "$MAX_WAIT" ]; do
    if ssh_ok; then ok=1; break; fi
    sleep "$POLL"; waited=$((waited + POLL))
    [ $((waited % 10)) -eq 0 ] && echo "  ...${waited}s waited"
  done

  if [ "$ok" -eq 1 ]; then
    tssh=$(date +%s)
    echo "[ready] >>> SSH reachable $((tssh - t0))s after 'up' <<<"
  else
    echo "[ready] >>> TIMEOUT: SSH not reachable within ${MAX_WAIT}s <<<"
  fi

  echo "--- container health ---"
  cid=$(dc ps -q sandbox 2>/dev/null)
  [ -n "$cid" ] && docker inspect --format \
    '  state={{.State.Status}} health={{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}} startedAt={{.State.StartedAt}}' \
    "$cid" 2>/dev/null

  echo "--- timestamped boot phases (look for big gaps; 'chown -R' vs 'skipping recursive') ---"
  dc logs -t sandbox 2>&1 \
    | grep -iE 'init-permissions|chown|skipping recursive|init-ssh-keys|init-firewall|init-workspace|bootstrap|listening on' \
    | sed 's/^/  /'
  echo ""
}

for i in $(seq 1 "$ITER"); do run_once "$i"; done
