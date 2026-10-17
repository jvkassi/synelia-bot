#!/usr/bin/env bash
# Synelia Bot: deploy the committed tree to konnect. Refuses a dirty tree, so DEPLOYED_COMMIT always
# names exactly what runs. Never prints secrets; never touches /srv/synelia-bot/secrets/.
#
# Gate 13 (post-deploy guard): before the restart, wait (max ~120 s) for running turns (unexpired
# synelia_thread_lock rows) and warn if some remain; after it, run `e2e.sh ownership gate`; on
# failure redeploy the previous DEPLOYED_COMMIT and exit non-zero.
#   E2E=/path/to/e2e.sh (default ../e2e.sh next to the repo); SKIP_GUARD=1 only for a rollback.
#
# Drain (inflight-check.sh): chat runs take no lock and are stored only at their end, so right before
# `up -d` the deploy waits (max 120 s, poll 10 s) until the request log shows no chat run in flight,
# then recreates with no pause in between. Still in flight after 120 s: the runs that would be cut are
# listed and the deploy ABORTS (images and compose file put back, nothing recreated), unless
# --force-cut. After the recreate, the runs it cut (POST /run of the old process never completed,
# including one that arrived between the check and the recreate) are printed as "RUN COUPÉ" lines,
# to announce in the channel.
set -euo pipefail
HOST=${HOST:-konnect}; DIR=/srv/synelia-bot
FORCE_CUT=${FORCE_CUT:-0}
for arg in "$@"; do
  case "$arg" in
    --force-cut) FORCE_CUT=1 ;;
    *) echo "usage: $0 [--force-cut]" >&2; exit 2 ;;
  esac
done
cd "$(git rev-parse --show-toplevel)"
# shellcheck source=served-check.sh
. deploy/synelia/served-check.sh
# shellcheck source=inflight-check.sh
INFLIGHT_LIB=$(pwd)/deploy/synelia/inflight-check.sh
. "$INFLIGHT_LIB"
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
  local compose_changed=0 old_start
  if ssh "$HOST" "cd $DIR && cmp -s src/deploy/synelia/docker-compose.yml docker-compose.yml || { cp -p docker-compose.yml docker-compose.yml.prev && cp src/deploy/synelia/docker-compose.yml docker-compose.yml && echo 'docker-compose.yml mis à jour depuis le commit'; }" | grep -q 'mis à jour'; then
    compose_changed=1; echo "docker-compose.yml mis à jour depuis le commit"
  fi
  # SYNELIA_BUILD_SHA: stamped into the image and the front bundle (/version.json, <meta name="synelia-version">).
  ssh "$HOST" "cd $DIR && SYNELIA_BUILD_SHA=$1 docker compose --progress plain build server migrate agent-mastra > tmp/build-$1.log 2>&1"
  # Request-log bind mount: owned by the image's unprivileged user, not world-readable. Done BEFORE
  # the waits so nothing sits between the last in-flight check and the recreate.
  ssh "$HOST" "cd $DIR && mkdir -p logs && chmod 750 logs && docker compose run --rm --no-deps --user root --entrypoint chown server openbot:openbot /app/logs >> tmp/build-$1.log 2>&1"
  if [ -z "${SKIP_GUARD:-}" ]; then
    for _ in $(seq 1 24); do
      n=$(active_locks); [ "$n" = "0" ] && break
      if [ "$n" = ERR ]; then echo "attente : verrous illisibles (psql), on attend quand même…"
      else echo "attente : $n réponse(s) en cours (synelia_thread_lock actif)…"; fi
      sleep 5
    done
    n=$(active_locks)
    [ "$n" = "0" ] || echo "AVERTISSEMENT : verrous actifs = $n après ~120 s, redémarrage quand même." >&2
    # Chat runs in flight (request log). Abort = nothing recreated: the freshly built images and the
    # compose file are put back, so a later `up -d` (add-tester…) cannot start the unannounced build.
    if ! inflight_gate 120; then
      ssh "$HOST" "cd $DIR && { ! docker image inspect synelia-bot-server:previous >/dev/null 2>&1 || { docker image tag synelia-bot-server:previous synelia-bot-server:phase0 && docker image tag synelia-bot-mastra:previous synelia-bot-mastra:phase0; }; }"
      [ "$compose_changed" = 0 ] || ssh "$HOST" "cd $DIR && cp -p docker-compose.yml.prev docker-compose.yml"
      echo "déploiement abandonné avant recréation : images :phase0 et docker-compose.yml remis à l'état servi ; DEPLOYED_COMMIT inchangé." >&2
      exit 3
    fi
    old_start=$INFLIGHT_LAST_STARTED
  else
    old_start=$(inflight_server_started)
  fi
  ssh "$HOST" "cd $DIR && docker compose up -d >> tmp/build-$1.log 2>&1 && echo $1 > src/DEPLOYED_COMMIT && echo deployed $1"
  inflight_cut_report "$old_start"
}

ENV_FILE=${E2E_ENV:-$(dirname "$E2E")/e2e.env}
# The running images become :previous BEFORE anything is built, so a bad build can be undone by retag.
PREV_IMAGE=$(tag_previous)
echo "image précédente (synelia-bot-server:previous) : ${PREV_IMAGE:-aucune}"
ship "$COMMIT"

# After the containers were recreated: what is SERVED must be the announced commit.
if ! check_served "$COMMIT" "$ENV_FILE"; then
  echo "ÉCHEC : le SHA servi n'est pas $COMMIT. FENÊTRE ARRÊTÉE : n'annoncez pas ce hash, ne lancez pas de test." >&2
  if ! migrations_changed "$PREVIOUS" "$COMMIT"; then
    echo "ROLLBACK AUTOMATIQUE REFUSÉ : des migrations (drizzle/ ou migrations/) ont changé entre ${PREVIOUS:-commit inconnu} et $COMMIT, et le service migrate les a déjà appliquées. Rien n'est remis en arrière ; intervention manuelle sur $HOST." >&2
    exit 1
  fi
  set +e; rollback_previous_image "$PREVIOUS" "$ENV_FILE"; rb=$?; set -e
  [ $rb = 0 ] || echo "ATTENTION : rollback non vérifié (code $rb), intervention manuelle sur $HOST." >&2
  exit 1
fi
echo "servi = $COMMIT (serveur, front, Traefik, meta)"

if [ -z "${SKIP_GUARD:-}" ]; then
  sleep 10
  set +e; "$E2E" ownership && "$E2E" gate; rc=$?; set -e
  if [ $rc = 3 ]; then
    echo "ÉCHEC : e2e.env missing/invalid pendant le garde ; pas de rollback automatique, vérifiez à la main." >&2
    exit 1
  fi
  if [ $rc != 0 ]; then
    echo "ÉCHEC du garde post-déploiement (e2e ownership gate)." >&2
    if [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$COMMIT" ] && ! migrations_changed "$PREVIOUS" "$COMMIT"; then
      echo "ROLLBACK AUTOMATIQUE REFUSÉ : migrations changées entre $PREVIOUS et $COMMIT (déjà appliquées). FENÊTRE ARRÊTÉE, intervention manuelle." >&2
    elif [ -n "$PREVIOUS" ] && [ "$PREVIOUS" != "$COMMIT" ]; then
      echo "rollback vers $PREVIOUS" >&2
      TMP=$(mktemp -d); git worktree add -q --detach "$TMP" "$PREVIOUS"
      (cd "$TMP" && SKIP_GUARD=1 HOST=$HOST bash -c "$(declare -f ship active_locks); . '$INFLIGHT_LIB'; DIR=$DIR; ship $PREVIOUS")
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
