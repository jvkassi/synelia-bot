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
# Gate 13 needs the e2e accounts: refuse BEFORE touching konnect if they are not usable, so a
# missing file never turns into a silent rollback.
if [ -z "${SKIP_GUARD:-}" ] && ! "$E2E" check-env; then
  echo "refus : e2e.env missing/invalid (voir e2e.env.example). Rien n'a été déployé." >&2
  exit 1
fi
PREVIOUS=$(ssh "$HOST" "cat $DIR/src/DEPLOYED_COMMIT 2>/dev/null || true")
ssh "$HOST" "free -m | sed -n 2p; uptime"

active_locks() { # prints a count, or "ERR" when the database could not be asked (fail closed)
  local out
  out=$(ssh "$HOST" "cd $DIR && docker compose exec -T postgres sh -c 'psql -U \"\$POSTGRES_USER\" -d \"\$POSTGRES_DB\" -tAc \"SELECT count(*) FROM synelia_thread_lock WHERE expires_at > now()\"'" 2>/dev/null | tr -d '[:space:]') || out=""
  case "$out" in ''|*[!0-9]*) echo ERR ;; *) echo "$out" ;; esac
}

ship() { # $1 = commit, run from a clean tree of that commit
  rsync -az --delete --exclude node_modules --exclude .git --exclude DEPLOYED_COMMIT \
    --exclude 'agent-mastra/.mastra' ./ "$HOST:$DIR/src/"
  # The compose file that runs is $DIR/docker-compose.yml: keep it equal to the committed one
  # (previous copy kept next to it, so a manual revert is one mv away).
  ssh "$HOST" "cd $DIR && cmp -s src/deploy/synelia/docker-compose.yml docker-compose.yml || { cp -p docker-compose.yml docker-compose.yml.prev && cp src/deploy/synelia/docker-compose.yml docker-compose.yml && echo 'docker-compose.yml mis à jour depuis le commit'; }"
  ssh "$HOST" "cd $DIR && docker compose --progress plain build server migrate agent-mastra > tmp/build-$1.log 2>&1"
  if [ -z "${SKIP_GUARD:-}" ]; then
    for _ in $(seq 1 24); do
      n=$(active_locks); [ "$n" = "0" ] && break
      if [ "$n" = ERR ]; then echo "attente : verrous illisibles (psql), on attend quand même…"
      else echo "attente : $n réponse(s) en cours (synelia_thread_lock actif)…"; fi
      sleep 5
    done
    n=$(active_locks)
    [ "$n" = "0" ] || echo "AVERTISSEMENT : verrous actifs = $n après ~120 s, redémarrage quand même." >&2
  fi
  # Request-log bind mount: owned by the image's unprivileged user, not world-readable.
  ssh "$HOST" "cd $DIR && mkdir -p logs && chmod 750 logs && docker compose run --rm --no-deps --user root --entrypoint chown server openbot:openbot /app/logs >> tmp/build-$1.log 2>&1"
  ssh "$HOST" "cd $DIR && docker compose up -d >> tmp/build-$1.log 2>&1 && echo $1 > src/DEPLOYED_COMMIT && echo deployed $1"
}

ship "$COMMIT"

if [ -z "${SKIP_GUARD:-}" ]; then
  sleep 10
  set +e; "$E2E" ownership && "$E2E" gate; rc=$?; set -e
  if [ $rc = 3 ]; then
    echo "ÉCHEC : e2e.env missing/invalid pendant le garde ; pas de rollback automatique, vérifiez à la main." >&2
    exit 1
  fi
  if [ $rc != 0 ]; then
    echo "ÉCHEC du garde post-déploiement (e2e ownership gate)." >&2
    if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$COMMIT" ]; then
      echo "rollback vers $PREVIOUS" >&2
      TMP=$(mktemp -d); git worktree add -q --detach "$TMP" "$PREVIOUS"
      (cd "$TMP" && SKIP_GUARD=1 HOST=$HOST bash -c "$(declare -f ship active_locks); DIR=$DIR; ship $PREVIOUS")
      git worktree remove --force "$TMP"
    fi
    exit 1
  fi
  # Pilot routes the UI still calls (warning only): the gate logs the method and prefix, no ids.
  blocked=$(ssh "$HOST" "cd $DIR && docker compose logs server --since 3m --no-log-prefix 2>/dev/null | grep -o 'pilot_blocked [A-Z]* /api/[^ ]*' | sort | uniq -c" || true)
  [ -z "$blocked" ] || { echo "AVERTISSEMENT pilot_blocked depuis le redémarrage :"; echo "$blocked"; }
fi

STAMP=$(date -u +%Y%m%dT%H%M%SZ)
git bundle create "/tmp/phase0-$STAMP.bundle" --all >/dev/null 2>&1
scp -q "/tmp/phase0-$STAMP.bundle" "$HOST:$DIR/backup/phase0-$STAMP.bundle"
ssh "$HOST" "chmod 600 $DIR/backup/phase0-$STAMP.bundle"; rm -f "/tmp/phase0-$STAMP.bundle"
echo "bundle $DIR/backup/phase0-$STAMP.bundle"
