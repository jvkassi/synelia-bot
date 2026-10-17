#!/usr/bin/env bash
# Synelia Bot: deploy the committed tree to konnect. Refuses a dirty tree, so DEPLOYED_COMMIT always
# names exactly what runs. Never prints secrets; never touches /srv/synelia-bot/secrets/.
#
# Gate 13 (post-deploy guard): before the restart, wait (max ~120 s) for running turns (unexpired
# synelia_thread_lock rows) and warn if some remain; after it, run `e2e.sh ownership gate`; on
# failure redeploy the previous DEPLOYED_COMMIT and exit non-zero.
#   E2E=/path/to/e2e.sh (default ../e2e.sh next to the repo); SKIP_GUARD=1 only for a rollback.
set -euo pipefail
HOST=${HOST:-konnect}; DIR=/srv/synelia-bot
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "refus : arbre git non propre (git status --porcelain non vide). Commitez d'abord." >&2
  exit 1
fi
COMMIT=$(git rev-parse HEAD)
E2E=${E2E:-$(cd .. && pwd)/e2e.sh}
PREVIOUS=$(ssh "$HOST" "cat $DIR/src/DEPLOYED_COMMIT 2>/dev/null || true")
ssh "$HOST" "free -m | sed -n 2p; uptime"

active_locks() {
  ssh "$HOST" "cd $DIR && docker compose exec -T postgres sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM synelia_thread_lock WHERE expires_at > now()\"' 2>/dev/null || echo 0" | tr -d '[:space:]'
}

ship() { # $1 = commit, run from a clean tree of that commit
  rsync -az --delete --exclude node_modules --exclude .git --exclude DEPLOYED_COMMIT \
    --exclude 'agent-mastra/.mastra' ./ "$HOST:$DIR/src/"
  ssh "$HOST" "cd $DIR && docker compose --progress plain build server migrate agent-mastra > tmp/build-$1.log 2>&1"
  if [ -z "${SKIP_GUARD:-}" ]; then
    for _ in $(seq 1 24); do
      n=$(active_locks); [ "${n:-0}" = "0" ] && break
      echo "attente : $n réponse(s) en cours (synelia_thread_lock actif)…"; sleep 5
    done
    n=$(active_locks)
    [ "${n:-0}" = "0" ] || echo "AVERTISSEMENT : $n réponse(s) encore en cours, redémarrage quand même." >&2
  fi
  ssh "$HOST" "cd $DIR && docker compose up -d >> tmp/build-$1.log 2>&1 && echo $1 > src/DEPLOYED_COMMIT && echo deployed $1"
}

ship "$COMMIT"

if [ -z "${SKIP_GUARD:-}" ]; then
  sleep 10
  if ! { "$E2E" ownership && "$E2E" gate; }; then
    echo "ÉCHEC du garde post-déploiement (e2e ownership gate)." >&2
    if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$COMMIT" ]; then
      echo "rollback vers $PREVIOUS" >&2
      TMP=$(mktemp -d); git worktree add -q --detach "$TMP" "$PREVIOUS"
      (cd "$TMP" && SKIP_GUARD=1 HOST=$HOST bash -c "$(declare -f ship active_locks); DIR=$DIR; ship $PREVIOUS")
      git worktree remove --force "$TMP"
    fi
    exit 1
  fi
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
git bundle create "/tmp/phase0-$STAMP.bundle" --all >/dev/null 2>&1
scp -q "/tmp/phase0-$STAMP.bundle" "$HOST:$DIR/backup/phase0-$STAMP.bundle"
ssh "$HOST" "chmod 600 $DIR/backup/phase0-$STAMP.bundle"; rm -f "/tmp/phase0-$STAMP.bundle"
echo "bundle $DIR/backup/phase0-$STAMP.bundle"
