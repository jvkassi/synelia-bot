#!/usr/bin/env bash
# Synelia Bot: deploy the committed tree to konnect. Refuses a dirty tree, so DEPLOYED_COMMIT always
# names exactly what runs. Never prints secrets; never touches /srv/synelia-bot/secrets/.
set -euo pipefail
HOST=${HOST:-konnect}; DIR=/srv/synelia-bot
cd "$(git rev-parse --show-toplevel)"
if [ -n "$(git status --porcelain)" ]; then
  echo "refus : arbre git non propre (git status --porcelain non vide). Commitez d'abord." >&2
  exit 1
fi
COMMIT=$(git rev-parse HEAD)
ssh "$HOST" "free -m | sed -n 2p; uptime"
rsync -az --delete --exclude node_modules --exclude .git --exclude DEPLOYED_COMMIT \
  --exclude 'agent-mastra/.mastra' ./ "$HOST:$DIR/src/"
ssh "$HOST" "cd $DIR && docker compose --progress plain build server migrate agent-mastra > tmp/build-$COMMIT.log 2>&1 \
  && docker compose up -d >> tmp/build-$COMMIT.log 2>&1 && echo $COMMIT > src/DEPLOYED_COMMIT && echo deployed $COMMIT"
STAMP=$(date -u +%Y%m%dT%H%M%SZ)
git bundle create "/tmp/phase0-$STAMP.bundle" --all >/dev/null 2>&1
scp -q "/tmp/phase0-$STAMP.bundle" "$HOST:$DIR/backup/phase0-$STAMP.bundle"
ssh "$HOST" "chmod 600 $DIR/backup/phase0-$STAMP.bundle"; rm -f "/tmp/phase0-$STAMP.bundle"
echo "bundle $DIR/backup/phase0-$STAMP.bundle"
