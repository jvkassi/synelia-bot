# Synelia Bot: helpers sourced by deploy.sh (no side effect when sourced). Never prints a secret.
# Needs: HOST, DIR (deploy.sh sets them). Tested by server/tests/synelia-deploy-served-check.test.ts
# with `ssh` and the public URL stubbed locally.

# A value for a curl config file (-K): double-quoted, with \ and " escaped (curl's config syntax).
curl_cfg_quote() {
  local s=${1//\\/\\\\}
  s=${s//\"/\\\"}
  printf '"%s"' "$s"
}

# Raw KEY=value from an env file (same parsing as e2e.sh / ui/*.mjs: everything after the first =).
env_value() { sed -n "s/^$2=//p" "$1" | head -1; }

# GET <path> on E2E_URL with the e2e basic-auth entry. Credentials reach curl on stdin (-K -), never
# argv, never stdout. Body on stdout; non-zero when curl fails.
public_get() { # $1 env file, $2 path
  local url user pass
  url=$(env_value "$1" E2E_URL); user=$(env_value "$1" E2E_BASIC_USER); pass=$(env_value "$1" E2E_BASIC_PASSWORD)
  printf 'user = %s\n' "$(curl_cfg_quote "$user:$pass")" | curl -sf --max-time 20 -K - "$url$2"
}

# The `server` and `front` SHAs out of a /version.json body; empty when the body is not that JSON
# (an image older than pass 9 answers /version.json with the SPA's index.html).
version_field() { # $1 body, $2 field
  printf '%s' "$1" | tr -d '[:space:]' | sed -n "s/^{.*\"$2\":\"\([0-9a-zA-Z]*\)\".*}\$/\1/p"
}

meta_sha() { grep -o 'name="synelia-version" content="[0-9a-zA-Z]*"' | sed 's/.*content="//; s/"$//' | head -1; }

# /version.json as served INSIDE the running server container (no proxy, no credentials).
inside_version() {
  local out=""
  for _ in $(seq 1 12); do
    out=$(ssh "$HOST" "cd $DIR && docker compose exec -T server bun -e 'fetch(\"http://127.0.0.1:3001/version.json\").then(r=>r.text()).then(t=>console.log(t))'" 2>/dev/null) || out=""
    [ -n "$out" ] && break
    sleep "${SERVED_RETRY_SLEEP:-5}"
  done
  printf '%s' "$out"
}

# Running server container uses the image currently tagged :phase0 (i.e. it WAS recreated).
container_on_tag() { # $1 tag
  local running tagged
  running=$(ssh "$HOST" "cd $DIR && docker inspect \$(docker compose ps -q server) --format '{{.Image}}'" 2>/dev/null) || running=""
  tagged=$(ssh "$HOST" "docker image inspect synelia-bot-server:$1 --format '{{.Id}}'" 2>/dev/null) || tagged=""
  [ -n "$running" ] && [ "$running" = "$tagged" ]
}

# 0 when the container runs the fresh :phase0 image and the server, the front, the public
# /version.json and the served <meta> all name $1. Prints what it saw (SHAs only).
check_served() { # $1 expected commit, $2 env file
  local want=$1 env_file=$2 inside s f outside meta ok=0
  if container_on_tag phase0; then echo "conteneur server : recréé sur l'image :phase0"
  else echo "conteneur server : PAS sur l'image :phase0 (non recréé ?)"; ok=1; fi
  inside=$(inside_version); s=$(version_field "$inside" server); f=$(version_field "$inside" front)
  echo "version (conteneur) : server=${s:-?} front=${f:-?}"
  [ "$s" = "$want" ] && [ "$f" = "$want" ] || ok=1
  if [ -r "$env_file" ]; then
    outside=$(public_get "$env_file" /version.json) || outside=""
    meta=$(public_get "$env_file" / | meta_sha) || meta=""
    echo "version (Traefik)   : server=$(version_field "$outside" server) front=$(version_field "$outside" front) ; meta index.html : ${meta:-absente}"
    [ "$(version_field "$outside" server)" = "$want" ] && [ "$(version_field "$outside" front)" = "$want" ] && [ "$meta" = "$want" ] || ok=1
  else
    echo "AVERTISSEMENT : $env_file illisible, vérification Traefik impossible." >&2; ok=1
  fi
  return $ok
}

# Database migrations between two commits (any `drizzle/` or `migrations/` directory). 0 = none,
# 1 = some, or the previous commit is unknown here (fail closed: we cannot prove there are none).
# The migrate service runs them on `up`, so an image rollback after them would run old code on a
# newer schema: no automatic rollback then.
migrations_changed() { # $1 previous commit, $2 new commit
  [ -n "$1" ] && git cat-file -e "$1^{commit}" 2>/dev/null || return 1
  [ -z "$(git diff --name-only "$1" "$2" -- ':(glob)**/drizzle/**' ':(glob)**/migrations/**')" ] && return 0
  return 1
}

# Before building: the images now running become :previous (server + mastra), and the compose file
# that runs is kept, so an image rollback needs no rebuild. Prints the :previous server image id.
tag_previous() {
  ssh "$HOST" "cd $DIR && cp -p docker-compose.yml docker-compose.yml.rollback && for i in synelia-bot-server synelia-bot-mastra; do docker image inspect \$i:phase0 >/dev/null 2>&1 && docker image tag \$i:phase0 \$i:previous; done; docker image inspect synelia-bot-server:previous --format '{{.Id}}' 2>/dev/null || true"
}

# Retag :previous → :phase0, restore the compose file, `up -d` without building, put DEPLOYED_COMMIT
# back, then prove the previous version is what runs: its /version.json names $1 or, when that image
# predates /version.json, the container runs the :previous image and DEPLOYED_COMMIT = $1.
rollback_previous_image() { # $1 previous commit, $2 env file
  local prev=$1 env_file=$2 inside s dc
  # server (+ migrate, same image) and agent-mastra go back TOGETHER, or not at all.
  if ! ssh "$HOST" "docker image inspect synelia-bot-server:previous >/dev/null 2>&1 && docker image inspect synelia-bot-mastra:previous >/dev/null 2>&1"; then
    echo "ROLLBACK IMPOSSIBLE : il manque synelia-bot-server:previous ou synelia-bot-mastra:previous sur $HOST." >&2; return 2
  fi
  echo "rollback : image :previous (${prev:-commit inconnu}) remise en :phase0, sans reconstruction"
  ssh "$HOST" "cd $DIR && { docker image tag synelia-bot-server:previous synelia-bot-server:phase0 && docker image tag synelia-bot-mastra:previous synelia-bot-mastra:phase0; } || exit 3; [ -f docker-compose.yml.rollback ] && cp -p docker-compose.yml.rollback docker-compose.yml; docker compose up -d --no-build >> tmp/rollback.log 2>&1 && echo '${prev}' > src/DEPLOYED_COMMIT"
  inside=$(inside_version); s=$(version_field "$inside" server)
  dc=$(ssh "$HOST" "cat $DIR/src/DEPLOYED_COMMIT 2>/dev/null" || true)
  if [ -n "$s" ]; then
    echo "rollback : version servie server=$s (attendu $prev)"
    [ "$s" = "$prev" ] || { echo "ROLLBACK NON VÉRIFIÉ : le conteneur sert $s." >&2; return 1; }
  else
    echo "rollback : pas de /version.json sur l'image précédente ; DEPLOYED_COMMIT=$dc"
    container_on_tag previous && [ "$dc" = "$prev" ] || { echo "ROLLBACK NON VÉRIFIÉ : conteneur pas sur :previous ou DEPLOYED_COMMIT=$dc." >&2; return 1; }
  fi
  echo "rollback vérifié : $prev"
}
